import { Request, Response } from 'express';
import User from '../models/User';
import InstrumentModel from '../models/Instrument';
import UpstoxInstrumentModel from '../models/UpstoxInstrument';
import { Signal } from '../models/Signal';
import { SignalExecutionResult } from '../models/SignalExecutionResult';
import { SignalExecutionQueueService } from '../services/SignalExecutionQueueService';
import { SignalBroadcastService } from '../services/SignalBroadcastService';
import log from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { evaluateBrokerCredentialHealth } from '../utils/brokerCredentialHealth';

export const queueExecution = async (req: Request, res: Response) => {
    try {
        const { signalId, lots } = req.body;
        const userId = (req as any).id;
        const userType = (req as any).userType;

        if (userType === "admin") {
            return res.status(403).json({
                status: false,
                error: "Admin accounts cannot queue user broker execution. Use /api/orders/place or /place-all.",
            });
        }

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

        if (String(signal.executionMode || "").toUpperCase() === "SERVER") {
            return res.status(200).json({
                status: true,
                message: "SERVER signal — backend worker executes on your Angel One account. No client action needed.",
                currentStatus: "SERVER_QUEUE",
            });
        }

        const user = await User.findById(userId)
            .select('client_key api_key broker broker_connected broker_verified licence trading_status +outgoing_ip +agent_url +broker_password +broker_totp_secret dedicated_ip_enabled')
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
        
        const credentialHealth = evaluateBrokerCredentialHealth(user, `queue_execution_${userId}`);
        const rawClientKey = user.client_key || "";
        const rawClientKeyLength = rawClientKey.length;
        const resolvedClientCode = credentialHealth.decrypted.clientCode;

        const activeKey = require('../config').config.encryptionKey || 'your-default-secure-key-32-chars-long';
        const activeKeyHash = require('crypto').createHash('sha256').update(String(activeKey)).digest('hex');
        log.info("[QUEUE_EXECUTION_INITIATED]", {
            userId,
            signalId,
            correlationId,
            broker: user.broker || "ANGELONE",
            clientKeyEncryptedLength: rawClientKeyLength,
            activeEncryptionSecretHash: activeKeyHash,
            clientCodeResolved: Boolean(resolvedClientCode),
            hasPassword: Boolean(user.broker_password),
            passwordResolved: Boolean(credentialHealth.decrypted.password),
            hasTotpSecret: Boolean(user.broker_totp_secret),
            totpResolved: Boolean(credentialHealth.decrypted.totpSecret),
            hasApiKey: Boolean(user.api_key),
            apiKeyResolved: Boolean(credentialHealth.decrypted.apiKey),
            brokerConnected: Boolean(user.broker_connected),
            brokerVerified: Boolean(user.broker_verified),
            missing: credentialHealth.missing,
        });

        // High-Visibility Telemetry Tracing logs
        console.log("=================================================================");
        console.log(`[SignalController] 🚨 QUEUE_EXECUTION INITIATED:`);
        console.log(`- Resolved userId: ${userId}`);
        console.log(`- client_key raw length before decrypt: ${rawClientKeyLength}`);
        console.log(`- Active ENCRYPTION_SECRET SHA256 Hash: ${activeKeyHash}`);
        console.log(`- Decrypted Client Code status: ${resolvedClientCode ? `RESOLVED (length: ${resolvedClientCode.length})` : "FAILED/NULL"}`);
        console.log(`- User Model Client Key in DB present: ${Boolean(user.client_key)}`);
        console.log(`- Decrypted Client Code status: ${resolvedClientCode ? "RESOLVED" : "FAILED_TO_DECRYPT"}`);
        console.log(`- Assigned Broker: ${user.broker || "ANGELONE"}`);
        console.log(`- Has Decrypted Password: ${user.broker_password ? "YES" : "NO"}`);
        console.log(`- Has TOTP Secret: ${user.broker_totp_secret ? "YES" : "NO"}`);
        console.log("=================================================================");

        if (!credentialHealth.ok) {
            log.error("[SignalController] Queue execution rejected: broker credential health check failed", {
                userId,
                signalId,
                missing: credentialHealth.missing,
            });
            return res.status(400).json({
                status: false,
                error: `Broker credentials incomplete or invalid: ${credentialHealth.missing.join(", ")}. Please reconnect broker credentials.`
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

        await SignalExecutionQueueService.enqueueUserExecution({
            userId: String(userId),
            clientCode: resolvedClientCode,
            signalId: String(signalId),
            broker: user.broker || "ANGELONE",
            clientOrderId,
            correlationId,
            outgoingIp: Boolean((user as any)?.dedicated_ip_enabled === true) ? (user.outgoing_ip || undefined) : undefined,
            agentUrl: Boolean((user as any)?.dedicated_ip_enabled === true) ? ((user as any).agent_url || undefined) : undefined,
            dedicatedIpEnabled: Boolean((user as any)?.dedicated_ip_enabled === true),
            orderData: {
                exchange: signal.exchange,
                tradingsymbol: signal.tradingsymbol,
                side: signal.side,
                quantity: (Number(lots) || 1) * signal.quantity,
                strategy: signal.strategy || "Manual",
                symboltoken: symboltoken || signal.symboltoken,
                orderType: "MARKET",
                ordertype: "MARKET",
                transactiontype: signal.side,
                producttype: "INTRADAY",
            },
        });

        return res.json({
            status: true,
            message: "Execution queued.",
            clientOrderId,
            correlationId,
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
