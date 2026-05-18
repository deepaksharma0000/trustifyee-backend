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
import { StartupDiagnostics } from "../utils/startupDiagnostics";
import {
    startRun as startRunLegacy,
    stopRun as stopRunLegacy,
    getStatus as getStatusLegacy,
    getRuns as getRunsLegacy,
    getTrades as getTradesLegacy,
    getSummary as getSummaryLegacy,
} from "./algoEngine.DEPRECATED";

const activeRiskWorkers: Worker[] = [];
let riskCheckInterval: NodeJS.Timeout | null = null;

/**
 * FIXED: Remove setInterval. Use BullMQ Repeatable Jobs (or local interval fallback).
 */
export const initAlgoRiskWorker = () => {
    if (!StartupDiagnostics.isBullMqCompatible) {
        log.warn("[REDIS] [COMPATIBILITY] Skipping BullMQ worker for 'risk-management' due to incompatible Redis version. Using local in-memory fallback.");
        return;
    }

    try {
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
                        if (lock) await lock.release().catch(() => {});
                    }
                }
            },
            { connection: redisConnection as any }
        );

        activeRiskWorkers.push(worker);

        // Schedule the repeatable job (runs every 30 seconds)
        riskQueue.add("risk-check-loop", {}, {
            repeat: { every: 30000 },
            removeOnComplete: true
        }).catch((err) => {
            log.error("[AlgoRiskWorker] Failed to add repeatable job to riskQueue:", err);
        });

        log.info("[AlgoRiskWorker] Worker initialized successfully.");
    } catch (err) {
        log.error("[AlgoRiskWorker] Failed to initialize worker:", err);
    }
};

export const shutdownAlgoRiskWorker = async () => {
    if (riskCheckInterval) {
        clearInterval(riskCheckInterval);
        riskCheckInterval = null;
        log.info("[AlgoRiskWorker] Local risk check interval cleared.");
    }
    log.info("[AlgoRiskWorker] Shutting down active risk workers...");
    await Promise.all(
        activeRiskWorkers.map((w) =>
            w.close().catch((err) => log.error("[AlgoRiskWorker] Error shutting down worker:", err))
        )
    );
    activeRiskWorkers.length = 0;
    log.info("[AlgoRiskWorker] Active risk workers shut down successfully.");
};

async function runRiskCycle(run: any, correlationId: string) {
    const logger = log.child({ correlationId, runId: run._id });
    
    const openPositions = await Position.find({ runId: run._id, status: "OPEN" }).lean();
    if (openPositions.length === 0) return;

    for (const p of openPositions) {
        const ltp = await dataFeedService.getCachedLtp(
            p.exchange,
            p.tradingsymbol,
            p.symboltoken || "",
            {
                userId: String((p as any).userId || ""),
                clientcode: String((p as any).clientcode || ""),
            }
        );
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
    log.info("Recovering Algo Engine state...");

    if (!StartupDiagnostics.isBullMqCompatible) {
        log.info("[AlgoEngine] [DEGRADED] Using local timer fallback for repeatable risk checks.");
        if (riskCheckInterval) {
            clearInterval(riskCheckInterval);
        }

        const runLocalCycle = async () => {
            const correlationId = randomUUID();
            const runningRuns = await AlgoRun.find({ status: "running" }).lean();
            
            for (const run of runningRuns) {
                const resource = `lock:algo-risk:${run._id}`;
                let lock;
                try {
                    lock = await redlock.acquire([resource], 20000);
                    await runRiskCycle(run, correlationId);
                } catch (err: any) {
                    // Locking issue or lock busy; locally execute since we're the only local scheduler
                    await runRiskCycle(run, correlationId).catch(cycleErr => log.error("Local risk check failed:", cycleErr));
                } finally {
                    if (lock) await lock.release().catch(() => {});
                }
            }
        };

        // Run immediately
        runLocalCycle().catch(err => log.error("Local risk execution failed:", err));

        riskCheckInterval = setInterval(() => {
            runLocalCycle().catch(err => log.error("Periodic local risk check execution failed:", err));
        }, 30000);
        return;
    }

    try {
        await riskQueue.add("risk-check-loop", {}, {
            repeat: { every: 30000 },
            jobId: "risk-check-loop" // Static ID prevents duplicates
        });
        log.info("[AlgoEngine] BullMQ risk check repeatable job recovered successfully.");
    } catch (err) {
        log.error("[AlgoEngine] Failed to recover repeatable risk check job:", err);
    }
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
