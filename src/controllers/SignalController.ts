import { Request, Response } from 'express';
import User from '../models/User';
import { Group } from '../models/GroupServices';
import { Position } from '../models/Position.model';
import { placeOrderForClient } from '../services/OrderService';
import log from '../utils/logger';
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

export const queueExecution = async (req: Request, res: Response) => {
    try {
        const { signalId, lots } = req.body;
        const userId = (req as any).id;

        if (!signalId) return res.status(400).json({ error: "Signal ID is required", status: false });

        if (existing) {
            return res.status(200).json({ status: true, message: "Signal already in queue or executed", currentStatus: existing.status });
        }

        const signal = await Signal.findById(signalId);
        if (!signal || signal.status === "FAILED") {
            return res.status(404).json({ error: "Signal not found or invalid", status: false });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: "User not found", status: false });

        // 1. Create Tracking Record (PENDING)
        await SignalExecutionResult.create({
            signalId,
            userId,
            broker: user.broker || "ANGELONE",
            status: "PENDING",
            source: "BACKEND_BLOCKED"
        });

        // 2. Enqueue for Execution
        const { Queue } = require("bullmq");
        const userQueue = new Queue(`trade-execution`, {
            connection: { host: process.env.REDIS_HOST || "127.0.0.1", port: 6379 }
        });

        // Resolve symboltoken
        const inst = await InstrumentModel.findOne({ tradingsymbol: signal.tradingsymbol, exchange: signal.exchange }).lean();
        const symboltoken = inst?.symboltoken || (await UpstoxInstrumentModel.findOne({ tradingsymbol: signal.tradingsymbol }).lean() as any)?.instrument_key;

        log.info(`[SignalController] Queueing signal ${signal.tradingsymbol} for ${user.user_name} (Token: ${symboltoken})`);

        await userQueue.add(`exec-${userId}-${signalId}`, {
            userId,
            signalId,
            clientCode: decrypt(user.client_key || ""),
            orderData: {
                exchange: signal.exchange,
                tradingsymbol: signal.tradingsymbol,
                side: signal.side,
                quantity: (lots || 1) * signal.quantity,
                strategy: signal.strategy,
                symboltoken
            }
        }, {
            attempts: 3, // Max 3 attempts
            backoff: { type: 'exponential', delay: 2000 }
        });

        return res.json({
            status: true,
            message: "Execution queued.",
            trackingStatus: "PENDING"
        });

    } catch (err: any) {
        log.error("Queue execution error:", err);
        res.status(500).json({ error: err.message, status: false });
    }
};


export const executeSignal = async (req: Request, res: Response) => {
    // Legacy / Blocked - Refer to SignalComplianceController
    return res.status(410).json({
        status: false,
        code: 'USER_DEVICE_EXECUTION_REQUIRED',
        error: 'Direct execution is disabled. Use /api/signals/queue-execution for compliant trading.'
    });
};


import { Request, Response } from 'express';
import { Signal } from '../models/Signal';
import { SignalExecutionResult } from '../models/SignalExecutionResult';
import { SignalBroadcastService } from '../services/SignalBroadcastService';
import log from '../utils/logger';
import mongoose from 'mongoose';

/**
 * FIXED: Clean Controller focusing on Request/Response handling
 */
export const broadcastSignal = async (req: Request, res: Response) => {
    try {
        const { signalId } = req.body;
        if (!signalId) return res.status(400).json({ error: "Signal ID is required", status: false });

        const result = await SignalBroadcastService.broadcast(signalId);
        
        res.status(200).json({
            status: true,
            message: "Broadcast initiated",
            ...result
        });
    } catch (err: any) {
        log.error("[SignalController] Broadcast error:", err);
        res.status(500).json({ error: err.message, status: false });
    }
};

/**
 * FIXED: Uses Aggregation to fetch stats for all signals in ONE query
 */
export const getAllSignals = async (req: Request, res: Response) => {
    try {
        const { strategy, search } = req.query;
        let matchStage: any = {};

        if (strategy && strategy !== 'All') matchStage.strategy = strategy;
        if (search) {
            matchStage.$or = [
                { symbol: { $regex: search, $options: 'i' } },
                { tradingsymbol: { $regex: search, $options: 'i' } }
            ];
        }

        const data = await Signal.aggregate([
            { $match: matchStage },
            { $sort: { createdAt: -1 } },
            { $limit: 100 },
            {
                $lookup: {
                    from: 'signalexecutionresults',
                    localField: '_id',
                    foreignField: 'signalId',
                    as: 'results'
                }
            },
            {
                $addFields: {
                    totalExecutions: { $size: '$results' },
                    successCount: {
                        $size: {
                            $filter: {
                                input: '$results',
                                as: 'r',
                                cond: { $eq: ['$$r.status', 'SUCCESS'] }
                            }
                        }
                    },
                    failCount: {
                        $size: {
                            $filter: {
                                input: '$results',
                                as: 'r',
                                cond: { $eq: ['$$r.status', 'FAILED'] }
                            }
                        }
                    }
                }
            },
            { $project: { results: 0 } } // Exclude raw results for performance
        ]);

        res.status(200).json({ status: true, data });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
};

export const getActiveSignals = async (req: Request, res: Response) => {
    // Similar aggregation as above but for ACTIVE status
    return getAllSignals(req, res); 
};

export const getExecutionStatus = async (req: Request, res: Response) => {
    try {
        const { signalId } = req.params;
        const userId = (req as any).id;

        if (!signalId) {
            return res.status(400).json({ status: false, error: "Signal ID is required" });
        }

        const execution = await SignalExecutionResult.findOne({ signalId, userId }).lean();

        if (!execution) {
            return res.status(404).json({ status: false, message: "No execution record found for this signal" });
        }

        return res.status(200).json({ status: true, data: execution });
    } catch (err: any) {
        log.error("[SIGNAL_EXECUTION] Error fetching execution status:", err);
        return res.status(500).json({ status: false, error: err.message });
    }
};
