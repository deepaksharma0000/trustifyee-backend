import { Request, Response } from 'express';
import User from '../models/User';
import { SignalExecutionResult } from '../models/SignalExecutionResult';
import { Signal } from '../models/Signal';
import log from '../utils/logger';

export const executeSignal = async (req: Request, res: Response) => {
    const signalId = req.body?.signalId;
    const userId = (req as any).id;

    if (signalId && userId) {
        await SignalExecutionResult.updateOne(
            { signalId, userId },
            {
                $setOnInsert: {
                    signalId,
                    userId,
                    broker: 'ANGELONE',
                    status: 'FAILED',
                    errorMessage: 'Server-side live execution disabled. Use the user-device executor.',
                    executedAt: new Date(),
                    source: 'BACKEND_BLOCKED',
                    orderType: 'LIMIT',
                }
            },
            { upsert: true }
        ).catch(() => undefined);
    }

    return res.status(410).json({
        status: false,
        code: 'USER_DEVICE_EXECUTION_REQUIRED',
        error: 'Server-side live execution has been disabled for compliance. Execute the signal from the user-device executor.'
    });
};

export const broadcastSignal = async (_req: Request, res: Response) => {
    return res.status(410).json({
        status: false,
        code: 'USER_DEVICE_EXECUTION_REQUIRED',
        error: 'Admin-side bulk execution has been disabled for compliance. Backend can only generate and publish signals.'
    });
};

export const recordExecutionResult = async (req: Request, res: Response) => {
    try {
        const userId = (req as any).id;
        const {
            signalId,
            status,
            orderId,
            errorMessage,
            executedAt,
            orderType,
            strategyId,
            brokerResponse,
            ipAddress,
        } = req.body || {};

        // 🛡️ COMPLIANCE VALIDATION
        if (!userId || !signalId) {
            return res.status(400).json({ status: false, error: 'Authorization ID and signalId are required for audit trail' });
        }

        if (orderType !== 'LIMIT') {
            log.error(`[AUDIT_REJECTED] Non-compliant orderType ${orderType} from ${userId}`);
            return res.status(400).json({ status: false, error: 'Compliance Violation: Only LIMIT order audit events are accepted' });
        }

        if (status !== 'SUCCESS' && status !== 'FAILED') {
            return res.status(400).json({ status: false, error: 'status must be SUCCESS or FAILED' });
        }

        const user = await User.findById(userId).lean();
        if (!user) {
            return res.status(404).json({ status: false, error: 'User not found' });
        }

        const signal = await Signal.findById(signalId).lean();
        if (!signal) {
            return res.status(404).json({ status: false, error: 'Signal not found' });
        }

        const result = await SignalExecutionResult.findOneAndUpdate(
            { signalId, userId },
            {
                signalId,
                userId,
                broker: user.broker || 'ANGELONE',
                orderId,
                status,
                errorMessage,
                executedAt: executedAt ? new Date(executedAt) : new Date(),
                source: 'USER_DEVICE',
                orderType: 'LIMIT',
                strategyId: strategyId || signal.strategy,
                ipAddress: ipAddress || req.ip,
                brokerResponse,
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        return res.json({ status: true, data: result });
    } catch (err: any) {
        log.error('[SIGNAL_EXECUTION] Failed to record execution event:', err);
        return res.status(500).json({ status: false, error: err.message });
    }
};
