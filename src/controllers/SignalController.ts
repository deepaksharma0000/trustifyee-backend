import { Request, Response } from 'express';
import { Signal } from '../models/Signal';
import User from '../models/User';
import { Position } from '../models/Position.model';
import { placeOrderForClient } from '../services/OrderService';
import { log } from '../utils/logger';
import { decrypt } from '../utils/encryption';
import AngelTokensModel from '../models/AngelTokens';
import { getInstrumentLtp } from '../services/MarketDataService';
import InstrumentModel from '../models/Instrument';
import UpstoxInstrumentModel from '../models/UpstoxInstrument';
import { SignalExecutionResult } from '../models/SignalExecutionResult';
import mongoose from 'mongoose';
import pLimit from 'p-limit';

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
        const quantity = (lots || 1) * signal.quantity;

        log.info(`Executing signal ${signalId} for user ${user.user_name} with ${lots} lots`);

        try {
            // Fetch live LTP if signal price is 0 or basic check
            let entryPrice = signal.price;
            try {
                // Find symboltoken/instrument_key
                let symboltoken = "";
                const inst = await InstrumentModel.findOne({ tradingsymbol: signal.tradingsymbol, exchange: signal.exchange }).lean();
                if (inst) symboltoken = inst.symboltoken;
                else {
                    const upstoxInst = await UpstoxInstrumentModel.findOne({ tradingsymbol: signal.tradingsymbol }).lean();
                    if (upstoxInst) symboltoken = upstoxInst.instrument_key;
                }

                if (symboltoken) {
                    const ltp = await getInstrumentLtp(signal.exchange, signal.tradingsymbol, symboltoken);
                    if (ltp > 0) entryPrice = ltp;
                }
            } catch (ltpErr) {
                log.warn("Could not fetch live LTP for signal execution, using signal price");
            }

            const resp = await placeOrderForClient(userId, client_key, {
                exchange: signal.exchange,
                tradingsymbol: signal.tradingsymbol,
                side: signal.side,
                transactiontype: signal.side,
                quantity: quantity,
                ordertype: "MARKET",
            });

            const orderid = resp?.data?.orderid || resp?.data?.data?.orderid || `SIG-${Date.now()}`;

            const position = await Position.create({
                userId: userId,
                clientcode: client_key,
                orderid: orderid,
                tradingsymbol: signal.tradingsymbol,
                exchange: signal.exchange,
                side: signal.side,
                quantity: quantity,
                entryPrice: entryPrice,
                status: "OPEN",
                strategy: signal.strategy,
                mode: "live",
                signalId: signal._id,
                signalType: signal.signalType,
                symboltoken: (await InstrumentModel.findOne({ tradingsymbol: signal.tradingsymbol }) || await UpstoxInstrumentModel.findOne({ tradingsymbol: signal.tradingsymbol }))?.symboltoken || (await UpstoxInstrumentModel.findOne({ tradingsymbol: signal.tradingsymbol }))?.instrument_key
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

export const broadcastSignal = async (req: Request, res: Response) => {
    try {
        const { signalId } = req.body;
        if (!signalId) return res.status(400).json({ error: "Signal ID is required", status: false });

        // 1. Atomic Lock Protection
        const signal = await Signal.findOneAndUpdate(
            { _id: signalId, status: "ACTIVE" },
            { $set: { status: "EXECUTION_IN_PROGRESS" } },
            { new: true }
        );

        if (!signal) {
            return res.status(400).json({
                status: false,
                error: "Signal not found or already being processed"
            });
        }

        log.info(`[SIGNAL_EXECUTION] Broadcast started for Signal: ${signalId} (${signal.tradingsymbol})`);

        // 2. Find all eligible users
        const users = await User.find({
            status: "active",
            trading_status: "enabled",
        }).lean();

        if (users.length === 0) {
            signal.status = "FAILED";
            await signal.save();
            log.warn(`[SIGNAL_EXECUTION] Broadcast aborted: No active users for Signal: ${signalId}`);
            return res.status(200).json({ status: true, message: "No active users to broadcast to.", finalStatus: "FAILED" });
        }

        const totalUsers = users.length;
        const concurrency = Number(process.env.BROADCAST_CONCURRENCY) || 10;
        const limit = pLimit(concurrency);

        // 3. Controlled Parallel Execution
        const results = await Promise.all(users.map(user =>
            limit(async () => {
                const userId = user._id;
                try {
                    // 4. Duplicate Check
                    const existingResult = await SignalExecutionResult.findOne({ signalId, userId });
                    if (existingResult) {
                        return { userId, status: "skipped", reason: "already_executed" };
                    }

                    let clientcode = user.client_key;
                    if (!clientcode) {
                        await SignalExecutionResult.create({
                            signalId,
                            userId,
                            broker: user.broker || "UNKNOWN",
                            status: "FAILED",
                            errorMessage: "No client code configured",
                            executedAt: new Date()
                        });
                        return { userId, status: "FAILED", error: "No client code" };
                    }

                    // Decrypt
                    try { clientcode = decrypt(clientcode); } catch (e) { }

                    let orderid = "";
                    let sideRes = signal.side;

                    if (user.licence === "Demo") {
                        // Logic for Demo (Paper)
                        orderid = `SIG-PAPER-${Date.now()}-${Math.random()}`;
                        await Position.create({
                            userId: user._id,
                            clientcode,
                            orderid: orderid,
                            tradingsymbol: signal.tradingsymbol,
                            exchange: signal.exchange,
                            side: signal.side,
                            quantity: signal.quantity,
                            entryPrice: signal.price,
                            status: "OPEN",
                            strategy: signal.strategy,
                            mode: "paper",
                            signalId: signal._id
                        });
                    } else {
                        // Live Execution
                        let entryPrice = signal.price;
                        try {
                            let symboltoken = "";
                            const inst = await InstrumentModel.findOne({ tradingsymbol: signal.tradingsymbol, exchange: signal.exchange }).lean();
                            if (inst) symboltoken = inst.symboltoken;
                            else {
                                const upstoxInst = await UpstoxInstrumentModel.findOne({ tradingsymbol: signal.tradingsymbol }).lean() as any;
                                if (upstoxInst) symboltoken = upstoxInst.instrument_key;
                            }

                            if (symboltoken) {
                                const ltp = await getInstrumentLtp(signal.exchange, signal.tradingsymbol, symboltoken);
                                if (ltp > 0) entryPrice = ltp;
                            }
                        } catch (e) { }

                        const resp = await placeOrderForClient(user._id, clientcode, {
                            exchange: signal.exchange,
                            tradingsymbol: signal.tradingsymbol,
                            side: signal.side,
                            transactiontype: signal.side,
                            quantity: signal.quantity,
                            ordertype: "MARKET",
                        });

                        orderid = resp?.data?.orderid || resp?.data?.data?.orderid || `BROKER-${Date.now()}`;

                        await Position.create({
                            userId: user._id,
                            clientcode,
                            orderid,
                            tradingsymbol: signal.tradingsymbol,
                            exchange: signal.exchange,
                            side: signal.side,
                            quantity: signal.quantity,
                            entryPrice: entryPrice,
                            status: "OPEN",
                            strategy: signal.strategy,
                            mode: "live",
                            signalId: signal._id,
                            symboltoken: (await InstrumentModel.findOne({ tradingsymbol: signal.tradingsymbol }) || await UpstoxInstrumentModel.findOne({ tradingsymbol: signal.tradingsymbol }))?.symboltoken || (await UpstoxInstrumentModel.findOne({ tradingsymbol: signal.tradingsymbol }))?.instrument_key
                        });
                    }

                    // 5. Track Success
                    await SignalExecutionResult.create({
                        signalId,
                        userId,
                        broker: user.broker || "ANGELONE",
                        orderId: orderid,
                        status: "SUCCESS",
                        executedAt: new Date()
                    });
                    return { userId, status: "SUCCESS", orderid };

                } catch (err: any) {
                    // 6. Track Failure
                    await SignalExecutionResult.create({
                        signalId,
                        userId,
                        broker: user.broker || "ANGELONE",
                        status: "FAILED",
                        errorMessage: err.message || "Unknown execution error",
                        executedAt: new Date()
                    });
                    return { userId, status: "FAILED", error: err.message };
                }
            })
        ));

        // 7. Success/Fail Counts Derived Safe from Results
        const successCount = results.filter((r: any) => r.status === "SUCCESS").length;
        const failCount = results.filter((r: any) => r.status === "FAILED").length;

        // 7. Final Status Resolution
        let finalStatus: any = "FAILED";
        if (successCount === totalUsers) {
            finalStatus = "CLOSED";
        } else if (successCount > 0) {
            finalStatus = "PARTIAL";
        } else {
            finalStatus = "FAILED";
        }

        signal.status = finalStatus;
        await signal.save();

        log.info(`[SIGNAL_EXECUTION] Completed. Signal: ${signalId}, Success: ${successCount}, Failed: ${failCount}, Final Status: ${finalStatus}`);

        res.status(200).json({
            status: true,
            message: "Broadcast completed",
            totalUsers,
            successCount,
            failCount,
            finalStatus,
            results
        });

    } catch (err: any) {
        log.error("[SIGNAL_EXECUTION] Fatal error during broadcast:", err);
        res.status(500).json({ error: err.message, status: false });
    }
};

export const getAllSignals = async (req: Request, res: Response) => {
    try {
        const { strategy, search } = req.query;
        let query: any = {};

        if (strategy && strategy !== 'All') {
            query.strategy = strategy;
        }

        if (search) {
            query.$or = [
                { symbol: { $regex: search, $options: 'i' } },
                { tradingsymbol: { $regex: search, $options: 'i' } },
                { strategy: { $regex: search, $options: 'i' } }
            ];
        }

        const signals = await Signal.find(query).sort({ createdAt: -1 }).lean();

        // Enhance with execution stats
        const enhancedSignals = await Promise.all(signals.map(async (sig: any) => {
            const results = await SignalExecutionResult.find({ signalId: sig._id }).select('status');
            const successCount = results.filter(r => r.status === 'SUCCESS').length;
            const failCount = results.filter(r => r.status === 'FAILED').length;

            return {
                ...sig,
                totalExecutions: results.length,
                successCount,
                failCount,
                currentStatus: sig.status
            };
        }));

        res.status(200).json({ status: true, data: enhancedSignals });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
};
