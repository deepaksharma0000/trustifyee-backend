import { Request, Response } from 'express';
import User from '../models/User';
import InstrumentModel from '../models/Instrument';
import UpstoxInstrumentModel from '../models/UpstoxInstrument';
import { Signal } from '../models/Signal';
import { SignalExecutionResult } from '../models/SignalExecutionResult';
import { tradeQueue } from '../utils/tradeQueue';
import { decrypt } from '../utils/encryption';
import { SignalBroadcastService } from '../services/SignalBroadcastService';
import log from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export const queueExecution = async (req: Request, res: Response) => {
    try {
        const { signalId, lots } = req.body;
        const userId = (req as any).id;

        if (!signalId) return res.status(400).json({ error: "Signal ID is required", status: false });

        // Block only if already SUCCESS
        const existing = await SignalExecutionResult.findOne({
            signalId, userId, status: "SUCCESS"
        }).lean();
        if (existing) {
            return res.status(200).json({
                status: true,
                message: "Signal already executed successfully",
                currentStatus: "SUCCESS"
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
            .select('+outgoing_ip +broker_password +broker_totp_secret')
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

        await SignalExecutionResult.create({
            signalId, userId, clientOrderId,
            broker: user.broker || "ANGELONE",
            status: "PENDING",
            correlationId,
            source: "USER_QUEUE"
        });

        await tradeQueue.add(`exec-${clientOrderId}`, {
            userId,
            signalId,
            clientOrderId,
            correlationId,
            clientCode: decrypt(user.client_key || ""),
            orderData: {
                exchange: signal.exchange,
                tradingsymbol: signal.tradingsymbol,
                side: signal.side,
                quantity: (Number(lots) || 1) * signal.quantity,
                strategy: signal.strategy || "Manual",
                symboltoken,
                broker: user.broker || "ANGELONE",
                outgoingIp: user.outgoing_ip || undefined
            }
        }, {
            attempts: 3,
            backoff: { type: "exponential", delay: 2000 }
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
