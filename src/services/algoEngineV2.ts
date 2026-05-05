// src/services/algoEngineV2.ts
import { Worker } from "bullmq";
import { redisConnection } from "../utils/redis";
import redlock from "../utils/redlock";
import { riskQueue } from "../utils/tradeQueue";
import { AlgoRun } from "../models/AlgoRun";
import { Position } from "../models/Position.model";
import { dataFeedService } from "./DataFeedService";
import { SignalBroadcastService } from "./SignalBroadcastService";
import log from "../utils/logger";
import { randomUUID } from "crypto";
import { AlgoTrade } from "../models/AlgoTrade";
import {
    startRun as startRunLegacy,
    stopRun as stopRunLegacy,
    getStatus as getStatusLegacy,
    getRuns as getRunsLegacy,
    getTrades as getTradesLegacy,
    getSummary as getSummaryLegacy,
} from "./algoEngine.DEPRECATED";

/**
 * FIXED: Remove setInterval. Use BullMQ Repeatable Jobs.
 */
export const initAlgoRiskWorker = () => {
    const worker = new Worker(
        "risk-management",
        async (job) => {
            const correlationId = randomUUID();
            const runningRuns = await AlgoRun.find({ status: "running" }).lean();
            
            for (const run of runningRuns) {
                // 🛡️ STRONG DISTRIBUTED LOCK (Redlock)
                const resource = `lock:algo-risk:${run._id}`;
                let lock;
                try {
                    lock = await redlock.acquire([resource], 20000); // 20s lock
                    
                    await runRiskCycle(run, correlationId);
                    
                } catch (err: any) {
                    log.debug(`Could not acquire lock for ${run._id}, skipping cycle.`);
                } finally {
                    if (lock) await lock.release();
                }
            }
        },
        { connection: redisConnection as any }
    );

    // Schedule the repeatable job (runs every 30 seconds)
    riskQueue.add("risk-check-loop", {}, {
        repeat: { every: 30000 },
        removeOnComplete: true
    });
};

async function runRiskCycle(run: any, correlationId: string) {
    const logger = log.child({ correlationId, runId: run._id });
    
    const openPositions = await Position.find({ runId: run._id, status: "OPEN" }).lean();
    if (openPositions.length === 0) return;

    for (const p of openPositions) {
        const ltp = await dataFeedService.getCachedLtp(p.exchange, p.tradingsymbol, p.symboltoken || "");
        if (ltp <= 0) continue;

        const slPrice = p.side === "BUY" ? p.entryPrice * (1 - run.stopLossPercent / 100) : p.entryPrice * (1 + run.stopLossPercent / 100);
        const tpPrice = p.side === "BUY" ? p.entryPrice * (1 + run.targetPercent / 100) : p.entryPrice * (1 - run.targetPercent / 100);

        if ((p.side === "BUY" && (ltp <= slPrice || ltp >= tpPrice)) || (p.side === "SELL" && (ltp >= slPrice || ltp <= tpPrice))) {
            logger.info(`Risk limit hit for ${p.tradingsymbol}. Triggering Exit Signal.`);
            
            // Trigger Exit via Broadcast Service (Transaction safe)
            const signal = await createExitSignal(p, ltp);
            await SignalBroadcastService.broadcast(String(signal._id));
        }
    }
}

async function createExitSignal(position: any, price: number) {
    const { Signal } = require("../models/Signal");
    return await Signal.create({
        symbol: position.tradingsymbol,
        exchange: position.exchange,
        side: position.side === "BUY" ? "SELL" : "BUY",
        tradingsymbol: position.tradingsymbol,
        price,
        quantity: position.quantity,
        status: "ACTIVE",
        signalType: "EXIT",
        strategy: position.strategy
    });
}

// ... rest of the helper functions (startRun, stopRun, recoverRunningRuns)
export async function recoverRunningRuns() {
    // Simply ensures the repeatable job is active. 
    // BullMQ handles job persistence across restarts.
    log.info("Recovering Algo Engine state...");
    await riskQueue.add("risk-check-loop", {}, {
        repeat: { every: 30000 },
        jobId: "risk-check-loop" // Static ID prevents duplicates
    });
}

export const startRun = startRunLegacy;
export const stopRun = stopRunLegacy;
export const getStatus = getStatusLegacy;
export const getRuns = getRunsLegacy;
export const getSummary = getSummaryLegacy;

export async function getTrades(runId: string, limit = 200, userId?: string) {
    if (userId) {
        return AlgoTrade.find({ runId, userId: String(userId) })
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();
    }
    return getTradesLegacy(runId, limit);
}
