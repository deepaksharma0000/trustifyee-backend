import { Request, Response } from 'express';
import { Signal } from '../models/Signal';
import User from '../models/User';
import { Position } from '../models/Position.model';
import { placeOrderForClient } from '../services/OrderService';
import { log } from '../utils/logger';
import { decrypt } from '../utils/encryption';
import AngelTokensModel from '../models/AngelTokens';

export const executeSignal = async (req: Request, res: Response) => {
    try {
        const { signalId, lots } = req.body;
        const userId = (req as any).id; // from auth middleware

        if (!signalId) return res.status(400).json({ error: "Signal ID is required", status: false });

        const signal = await Signal.findById(signalId);
        if (!signal || signal.status !== "ACTIVE") {
            return res.status(404).json({ error: "Signal not found or inactive", status: false });
        }

        const user = await User.findById(userId);
        if (!user || user.licence !== "Live") {
            return res.status(403).json({ error: "User not eligible for live execution", status: false });
        }

        if (!user.broker_verified) {
            return res.status(403).json({ error: "Broker not verified by admin", status: false });
        }

        const client_key = decrypt(user.client_key || "");
        if (!client_key) return res.status(400).json({ error: "Broker connection details missing", status: false });

        // Calculate quantity (assuming lot size = 1 if not provided, else multiply)
        // Note: Real lot size should come from contract, but here user specifies lots
        const quantity = (lots || 1) * signal.quantity;

        log.info(`Executing signal ${signalId} for user ${user.user_name} with ${lots} lots`);

        try {
            const resp = await placeOrderForClient(client_key, {
                exchange: signal.exchange,
                tradingsymbol: signal.tradingsymbol,
                side: signal.side,
                transactiontype: signal.side,
                quantity: quantity,
                ordertype: "MARKET",
            });

            const orderid = resp?.data?.orderid || resp?.data?.data?.orderid || `SIG-${Date.now()}`;

            const position = await Position.create({
                clientcode: client_key,
                orderid: orderid,
                tradingsymbol: signal.tradingsymbol,
                exchange: signal.exchange,
                side: signal.side,
                quantity: quantity,
                entryPrice: signal.price, // Or fetch live LTP
                status: "OPEN",
                strategy: signal.strategy,
                mode: "live",
                signalId: signal._id,
                signalType: signal.signalType
            });

            res.status(200).json({
                message: "Signal executed successfully!",
                status: true,
                data: position
            });

        } catch (orderErr: any) {
            log.error(`Order failed for signal ${signalId}:`, orderErr);
            res.status(500).json({ error: orderErr.message || "Broker order failed", status: false });
        }

    } catch (err: any) {
        log.error("Execution error:", err);
        res.status(500).json({ error: err.message, status: false });
    }
};

export const getActiveSignals = async (req: Request, res: Response) => {
    try {
        const signals = await Signal.find({ status: "ACTIVE" }).sort({ createdAt: -1 });
        res.status(200).json({ ok: true, data: signals });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};
