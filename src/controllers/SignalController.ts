import { Request, Response } from 'express';
import User from '../models/User';
import InstrumentModel from '../models/Instrument';
import UpstoxInstrumentModel from '../models/UpstoxInstrument';
import { Signal } from '../models/Signal';
import { SignalExecutionResult } from '../models/SignalExecutionResult';
import { getTradeQueueForBroker } from '../utils/tradeQueue';
import { decrypt } from '../utils/encryption';
import { SignalBroadcastService } from '../services/SignalBroadcastService';
import log from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export const queueExecution = async (req: Request, res: Response) => {
    try {
        const { signalId, lots } = req.body;
        const userId = (req as any).id;

        if (!signalId) return res.status(400).json({ error: "Signal ID is required", status: false });

        const existingExecution = await SignalExecutionResult.findOne({
            signalId,
            userId
        }).lean();

        if (existingExecution?.status === "SUCCESS") {
            return res.status(200).json({
                status: true,
                message: "Signal already executed successfully",
                currentStatus: "SUCCESS"
            });
        }

        if (existingExecution?.status === "PENDING" || existingExecution?.status === "QUEUED") {
            return res.status(200).json({
                status: true,
                message: "Signal execution already queued.",
                currentStatus: existingExecution.status,
                clientOrderId: existingExecution.clientOrderId
            });
        }

        // Reset stuck PENDING older than 2 mins
        await SignalExecutionResult.updateMany(
            { signalId, userId, status: "PENDING",
              createdAt: { $lt: new Date(Date.now() - 2 * 60 * 1000) } },
            { $set: { status: "FAILED", error: "Auto-reset: stuck PENDING" } }
        );

        const signal = await Signal.findById(signalId);
        if (!signal || signal.status === "FAILED") {
            return res.status(404).json({ error: "Signal not found or invalid", status: false });
        }

        const user = await User.findById(userId)
            .select('+outgoing_ip +agent_url +broker_password +broker_totp_secret dedicated_ip_enabled')
            .lean();
        if (!user) return res.status(404).json({ error: "User not found", status: false });

        // Resolve instrument token
        const inst = await InstrumentModel.findOne({
            tradingsymbol: signal.tradingsymbol,
            exchange: signal.exchange
        }).lean();
        const upstoxInst = await UpstoxInstrumentModel.findOne({
            tradingsymbol: signal.tradingsymbol
        }).lean() as any;
        const symboltoken = inst?.symboltoken || upstoxInst?.instrument_key;

        const clientOrderId = `USER-${uuidv4()}`;
        const correlationId = uuidv4();
        
        const rawClientKey = user.client_key || "";
        const rawClientKeyLength = rawClientKey.length;
        const resolvedClientCode = decrypt(rawClientKey, "client_key");

        const activeKey = require('../config').config.encryptionKey || 'your-default-secure-key-32-chars-long';
        const activeKeyHash = require('crypto').createHash('sha256').update(String(activeKey)).digest('hex');

        // High-Visibility Telemetry Tracing logs
        console.log("=================================================================");
        console.log(`[SignalController] 🚨 QUEUE_EXECUTION INITIATED:`);
        console.log(`- Resolved userId: ${userId}`);
        console.log(`- client_key raw length before decrypt: ${rawClientKeyLength}`);
        console.log(`- Active ENCRYPTION_SECRET SHA256 Hash: ${activeKeyHash}`);
        console.log(`- Decrypted Client Code status: ${resolvedClientCode ? `RESOLVED (length: ${resolvedClientCode.length})` : "FAILED/NULL"}`);
        console.log(`- User Model Client Key in DB: ${user.client_key}`);
        console.log(`- Decrypted Client Code: ${resolvedClientCode || "FAILED_TO_DECRYPT"}`);
        console.log(`- Assigned Broker: ${user.broker || "ANGELONE"}`);
        console.log(`- Has Decrypted Password: ${user.broker_password ? "YES" : "NO"}`);
        console.log(`- Has TOTP Secret: ${user.broker_totp_secret ? "YES" : "NO"}`);
        console.log("=================================================================");

        if (!resolvedClientCode) {
            console.error(`[SignalController] ❌ Queue Execution Rejected: client_key decryption failed or returned empty for userId: ${userId}`);
            return res.status(400).json({
                status: false,
                error: "Client code is missing or invalid. Please reconnect broker credentials."
            });
        }

        await SignalExecutionResult.findOneAndUpdate(
            { signalId, userId },
            {
                signalId,
                userId,
                clientOrderId,
                broker: user.broker || "ANGELONE",
                status: "PENDING",
                correlationId,
                source: "USER_QUEUE"
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        const broker = String(user.broker || "ANGELONE").toUpperCase();
        const queue = getTradeQueueForBroker(broker);

        await queue.add(`exec-${clientOrderId}`, {
            userId,
            signalId,
            clientOrderId,
            correlationId,
            clientCode: resolvedClientCode,
            outgoingIp: Boolean((user as any)?.dedicated_ip_enabled === true) ? (user.outgoing_ip || undefined) : undefined,
            agentUrl: Boolean((user as any)?.dedicated_ip_enabled === true) ? ((user as any).agent_url || undefined) : undefined,
            dedicatedIpEnabled: Boolean((user as any)?.dedicated_ip_enabled === true),
            orderData: {
                exchange: signal.exchange,
                tradingsymbol: signal.tradingsymbol,
                side: signal.side,
                quantity: (Number(lots) || 1) * signal.quantity,
                strategy: signal.strategy || "Manual",
                symboltoken,
                broker: user.broker || "ANGELONE"
            }
        }, {
            attempts: 3,
            backoff: { type: "exponential", delay: 2000 },
            jobId: `signal-exec-${clientOrderId}`
        });

        return res.json({
            status: true,
            message: "Execution queued.",
            clientOrderId,
            trackingStatus: "PENDING"
        });
    } catch (err: any) {
        log.error("Queue execution error:", err);
        return res.status(500).json({ error: err.message, status: false });
    }
};

export const executeSignal = async (_req: Request, res: Response) => {
    return res.status(410).json({
        status: false,
        code: "USER_DEVICE_EXECUTION_REQUIRED",
        error: "Direct execution is disabled. Use /api/signals/queue-execution for compliant trading."
    });
};

export const broadcastSignal = async (req: Request, res: Response) => {
    try {
        const { signalId } = req.body;
        if (!signalId) return res.status(400).json({ error: "Signal ID is required", status: false });
        const result = await SignalBroadcastService.broadcast(signalId);
        res.status(200).json({ status: true, message: "Broadcast initiated", ...result });
    } catch (err: any) {
        log.error("[SignalController] Broadcast error:", err);
        res.status(500).json({ error: err.message, status: false });
    }
};
export const getAllSignals = async (req: Request, res: Response) => {
    try {
        const signals = await Signal.find().sort({ createdAt: -1 }).limit(100);
        res.json({ status: true, data: signals });
    } catch (err: any) {
        res.status(500).json({ status: false, error: err.message });
    }
};

export const getActiveSignals = async (req: Request, res: Response) => {
    try {
        const signals = await Signal.find({ status: "ACTIVE" }).sort({ createdAt: -1 });
        res.json({ status: true, data: signals });
    } catch (err: any) {
        res.status(500).json({ status: false, error: err.message });
    }
};

export const getExecutionStatus = async (req: Request, res: Response) => {
    try {
        const { signalId } = req.params;
        const userId = (req as any).id;
        const result = await SignalExecutionResult.findOne({ signalId, userId }).lean();
        if (!result) return res.json({ status: true, data: { status: "PENDING" } });
        res.json({ status: true, data: result });
    } catch (err: any) {
        res.status(500).json({ status: false, error: err.message });
    }
};

export const getExecutionSummary = async (req: Request, res: Response) => {
    try {
        const { signalId } = req.params;
        if (!signalId) {
            return res.status(400).json({ status: false, error: "Signal ID is required" });
        }

        const signal = await Signal.findById(signalId).lean() as any;
        if (!signal) {
            return res.status(404).json({ status: false, error: "Signal not found" });
        }

        const rows = await SignalExecutionResult.find({ signalId }).sort({ createdAt: 1 }).lean() as any[];
        const userIds = rows.map((r) => String(r.userId || "")).filter(Boolean);

        const users = await User.find({ _id: { $in: userIds } })
            .select("user_name email broker")
            .lean() as any[];
        const userMap = new Map(users.map((u) => [String(u._id), u]));

        const summary = {
            totalUsers: Number(signal.totalExecutions || rows.length || 0),
            successCount: 0,
            failedCount: 0,
            pendingCount: 0,
            queuedCount: 0,
            unknownCount: 0,
            brokerWise: {} as Record<string, { total: number; success: number; failed: number; pending: number; queued: number }>,
        };

        const details = rows.map((row) => {
            const status = String(row.status || "").toUpperCase();
            const broker = String(row.broker || userMap.get(String(row.userId))?.broker || "UNKNOWN").toUpperCase();

            if (!summary.brokerWise[broker]) {
                summary.brokerWise[broker] = { total: 0, success: 0, failed: 0, pending: 0, queued: 0 };
            }

            summary.brokerWise[broker].total += 1;

            if (status === "SUCCESS") {
                summary.successCount += 1;
                summary.brokerWise[broker].success += 1;
            } else if (status === "FAILED") {
                summary.failedCount += 1;
                summary.brokerWise[broker].failed += 1;
            } else if (status === "PENDING") {
                summary.pendingCount += 1;
                summary.brokerWise[broker].pending += 1;
            } else if (status === "QUEUED") {
                summary.queuedCount += 1;
                summary.brokerWise[broker].queued += 1;
            } else {
                summary.unknownCount += 1;
            }

            const user = userMap.get(String(row.userId));
            return {
                userId: String(row.userId || ""),
                userName: user?.user_name || null,
                email: user?.email || null,
                broker,
                status,
                errorMessage: row.errorMessage || null,
                orderId: row.orderId || null,
                clientOrderId: row.clientOrderId || null,
                correlationId: row.correlationId || null,
                usedIp: row.ipAddress || null,
                brokerOrderStatus: row.brokerOrderStatus || null,
                brokerRejectReason: row.brokerRejectReason || null,
                lastSyncedAt: row.lastSyncedAt || null,
                executedAt: row.executedAt || null,
                updatedAt: row.updatedAt || null,
            };
        });

        const accounted = summary.successCount + summary.failedCount + summary.pendingCount + summary.queuedCount + summary.unknownCount;
        const notAttempted = Math.max(0, summary.totalUsers - accounted);

        return res.json({
            status: true,
            signal: {
                signalId: String(signal._id),
                strategy: signal.strategy || null,
                tradingsymbol: signal.tradingsymbol || null,
                side: signal.side || null,
                signalStatus: signal.status || null,
                createdAt: signal.createdAt || null,
            },
            summary: {
                ...summary,
                notAttemptedCount: notAttempted,
            },
            details,
        });
    } catch (err: any) {
        log.error("[SignalController] getExecutionSummary error", err);
        return res.status(500).json({ status: false, error: err.message || "Failed to fetch execution summary" });
    }
};
