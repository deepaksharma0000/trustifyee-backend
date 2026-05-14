// src/services/MonitoringService.ts
import {
    getAllTradeQueueNames,
    getTradeQueueByName,
    getTotalTradeQueueFailedCount,
    getTotalTradeQueueWaitingCount,
    riskQueue
} from "../utils/tradeQueue";
import log from "../utils/logger";
import redis from "../utils/redis";

export class MonitoringService {
    static async logSystemMetrics() {
        try {
            const queueNames = getAllTradeQueueNames();
            const [tradeWaiting, tradeFailed, riskWaiting, perQueueWaiting] = await Promise.all([
                getTotalTradeQueueWaitingCount(),
                getTotalTradeQueueFailedCount(),
                riskQueue.getWaitingCount(),
                Promise.all(
                    queueNames.map(async (name) => ({
                        name,
                        waiting: await getTradeQueueByName(name).getWaitingCount().catch(() => 0),
                        failed: await getTradeQueueByName(name).getFailedCount().catch(() => 0),
                    }))
                )
            ]);

            const activeBrokers = ["ANGELONE", "UPSTOX"];
            const resources = ["ORDER", "LTP", "AUTH"];
            const cbStates: Record<string, string> = {};
            
            for (const b of activeBrokers) {
                const states = await Promise.all(resources.map((r) => redis.get(`CB:STATE:${b}:${r}`)));
                cbStates[b] = states.some((v) => v === "OPEN") ? "OPEN" : "CLOSED";
            }

            log.info({
                type: "SYSTEM_METRICS",
                queues: {
                    trade: { waiting: tradeWaiting, failed: tradeFailed, byQueue: perQueueWaiting },
                    risk: { waiting: riskWaiting }
                },
                circuitBreakers: cbStates,
                timestamp: new Date()
            });
        } catch (err) {
            log.error("Failed to fetch metrics", err);
        }
    }
}
