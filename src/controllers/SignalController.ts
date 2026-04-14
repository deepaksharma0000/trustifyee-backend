import { Request, Response } from 'express';
import User from '../models/User';
import { Group } from '../models/GroupServices';
import { Position } from '../models/Position.model';
import { placeOrderForClient } from '../services/OrderService';
import { log } from '../utils/logger';
import { decrypt } from '../utils/encryption';
import AngelTokensModel from '../models/AngelTokens';
import { getInstrumentLtp } from '../services/MarketDataService';
import InstrumentModel from '../models/Instrument';
import UpstoxInstrumentModel from '../models/UpstoxInstrument';
import { SignalExecutionResult } from '../models/SignalExecutionResult';
import { Signal } from '../models/Signal';
import mongoose from 'mongoose';
import pLimit from 'p-limit';
import { SystemSetting } from '../models/SystemSetting';

export const executeSignal = async (req: Request, res: Response) => {
    try {
        const { signalId, lots } = req.body;
        const userId = (req as any).id;

        // 1. Global Kill Switch Check
        const globalStatus = await SystemSetting.findOne({ key: 'global_trading_status' }).lean() as any;
        if (globalStatus && globalStatus.value === "disabled") {
            return res.status(403).json({ error: "ALL TRADING IS GLOBALLY DISABLED BY ADMIN (KILL SWITCH ACTIVE)", status: false });
        }

        if (!signalId) return res.status(400).json({ error: "Signal ID is required", status: false });

        // FIX: Idempotency check — prevent duplicate execution of SAME signal by SAME user
        const existingExecution = await SignalExecutionResult.findOne({ signalId, userId });
        if (existingExecution && existingExecution.status === "SUCCESS") {
            log.warn(`[SignalController] Blocked duplicate execution for user ${userId} on signal ${signalId}`);
            return res.status(200).json({ 
                message: "Signal already executed successfully", 
                status: true, 
                alreadyExecuted: true 
            });
        }


        const signal = await Signal.findById(signalId);
        if (!signal || signal.status !== "ACTIVE") {
            return res.status(404).json({ error: "Signal not found or inactive", status: false });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: "User not found", status: false });
        }

        const isDemo = user.licence === "Demo";

        if (!isDemo && !user.broker_verified) {
            return res.status(403).json({ error: "Broker not verified by admin", status: false });
        }

        let client_key = "";
        if (!isDemo) {
            client_key = decrypt(user.client_key || "");
            if (!client_key) return res.status(400).json({ error: "Broker connection details missing", status: false });
        } else {
            client_key = decrypt(user.client_key || "") || "DEMO-USER";
        }

        // Calculate quantity (assuming lot size = 1 if not provided, else multiply)
        const quantity = (lots || 1) * signal.quantity;

        log.info(`Executing signal ${signalId} for user ${user.user_name} (Licence: ${user.licence}) with ${lots} lots`);

        try {
            // Fetch live LTP
            let entryPrice = signal.price;
            let symboltoken = "";
            try {
                // Find symboltoken/instrument_key
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

            let orderid = "";
            let mode = "live";

            if (isDemo) {
                orderid = `SIG-PAPER-${Date.now()}-${Math.random().toString(36).substring(7)}`;
                mode = "paper";
            } else {
                const resp = await placeOrderForClient(userId, client_key, {
                    exchange: signal.exchange,
                    tradingsymbol: signal.tradingsymbol,
                    side: signal.side,
                    transactiontype: signal.side,
                    quantity: quantity,
                    ordertype: "MARKET",
                });
                orderid = resp?.data?.orderid || resp?.data?.data?.orderid || `SIG-${Date.now()}`;
            }

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
                mode: mode,
                signalId: signal._id,
                signalType: signal.signalType,
                symboltoken: symboltoken || (await InstrumentModel.findOne({ tradingsymbol: signal.tradingsymbol }) || await UpstoxInstrumentModel.findOne({ tradingsymbol: signal.tradingsymbol }))?.symboltoken
            });

            res.status(200).json({
                message: isDemo ? "Signal executed (Paper Trade)" : "Signal executed successfully!",
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

        // 1. Global Kill Switch Check
        const globalStatus = await SystemSetting.findOne({ key: 'global_trading_status' }).lean() as any;
        if (globalStatus && globalStatus.value === "disabled") {
            return res.status(403).json({ error: "ALL TRADING IS GLOBALLY DISABLED BY ADMIN (KILL SWITCH ACTIVE)", status: false });
        }

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

        // 2. Identify eligible groups (Groups that contain a service for this signal's symbol)
        const eligibleGroups = await Group.find({
            $or: [
                { "services.name": { $regex: new RegExp(signal.symbol, "i") } },
                { "services.segment": { $regex: new RegExp(signal.symbol, "i") } }
            ]
        }).select('name services').lean();

        const eligibleGroupNames = eligibleGroups.map(g => g.name);

        if (eligibleGroupNames.length === 0) {
            signal.status = "FAILED";
            await signal.save();
            log.warn(`[SIGNAL_EXECUTION] Broadcast aborted: No Group Services found for Symbol: ${signal.symbol}`);
            return res.status(200).json({ status: true, message: "No groups configured for this symbol.", finalStatus: "FAILED" });
        }

        // 3. Find all eligible users
        // Criteria: Active, Trading Enabled, Has Signal's Strategy, and belongs to an eligible Group
        const users = await User.find({
            status: "active",
            trading_status: "enabled",
            strategies: signal.strategy, // MongoDB matches if the string is in the array
            group_service: { $in: eligibleGroupNames }
        }).lean();

        if (users.length === 0) {
            signal.status = "FAILED";
            await signal.save();
            log.warn(`[SIGNAL_EXECUTION] Broadcast aborted: No matching users (Strategy: ${signal.strategy}, Symbol: ${signal.symbol})`);
            return res.status(200).json({ status: true, message: "No matching users for this strategy/group.", finalStatus: "FAILED" });
        }

        const totalUsers = users.length;
        const concurrency = Number(process.env.BROADCAST_CONCURRENCY) || 10;
        const limit = pLimit(concurrency);

        // 4. Controlled Parallel Execution
        const results = await Promise.all(users.map(user =>
            limit(async () => {
                const userId = user._id;
                try {
                    // 5. Determine User-Specific Quantity
                    const userGroupName = user.group_service;
                    const groupConfig = eligibleGroups.find(g => g.name === userGroupName);
                    
                    // ✅ Precise matching to avoid FINNIFTY matching NIFTY
                    const serviceConfig = groupConfig?.services.find(s =>
                        (s.name && s.name.toUpperCase() === signal.symbol.toUpperCase()) ||
                        (s.segment && s.segment.toUpperCase() === signal.symbol.toUpperCase())
                    );

                    // 🔧 Personalized Lot Multiplier Logic
                    const symbolMap: any = {
                        'BANKNIFTY': 'BankNifty',
                        'NIFTY': 'NIFTY',
                        'FINNIFTY': 'FINNIFTY',
                        'SENSEX': 'SENSEX'
                    };
                    const multiplierKey = symbolMap[signal.symbol.toUpperCase()] || signal.symbol.toUpperCase();
                    
                    // Priority: Personal Multiplier -> Group Quantity -> 1
                    const userMultiplier = (user.lot_multipliers && user.lot_multipliers[multiplierKey]) || serviceConfig?.group_qty || 1;
                    const finalQuantity = signal.quantity * userMultiplier;

                    // 6. Duplicate Check
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
                        // Capture LTP for Paper trades if no price
                        let paperEntryPrice = signal.price || 0;
                        if (paperEntryPrice === 0) {
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
                                    if (ltp > 0) paperEntryPrice = ltp;
                                }
                            } catch (e: any) { log.warn("Signal paper LTP fetch failed", e.message); }
                        }

                        orderid = `SIG-PAPER-${Date.now()}-${Math.random()}`;
                        await Position.create({
                            userId: user._id,
                            clientcode,
                            orderid: orderid,
                            tradingsymbol: signal.tradingsymbol,
                            exchange: signal.exchange,
                            side: signal.side,
                            quantity: finalQuantity,
                            entryPrice: paperEntryPrice,
                            status: "OPEN",
                            strategy: signal.strategy,
                            mode: "paper",
                            signalId: signal._id,
                            tradeType: "Signal"
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
                            quantity: finalQuantity,
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
                            quantity: finalQuantity,
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

export const getActiveSignals = async (req: Request, res: Response) => {
    try {
        const signals = await Signal.find({ status: { $in: ['ACTIVE', 'EXECUTION_IN_PROGRESS'] } })
            .sort({ createdAt: -1 })
            .limit(20)
            .lean();

        // Enhance with execution stats
        const data = await Promise.all(signals.map(async (sig: any) => {
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

        res.status(200).json({ ok: true, status: true, data });
    } catch (err: any) {
        res.status(500).json({ ok: false, status: false, error: err.message });
    }
};
