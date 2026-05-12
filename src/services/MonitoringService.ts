// src/services/MonitoringService.ts
import { tradeQueue, riskQueue } from "../utils/tradeQueue";
import log from "../utils/logger";
import redis from "../utils/redis";

export class MonitoringService {
    static async logSystemMetrics() {
        try {
            const [tradeWaiting, tradeFailed, riskWaiting] = await Promise.all([
                tradeQueue.getWaitingCount(),
                tradeQueue.getFailedCount(),
                riskQueue.getWaitingCount()
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
                    trade: { waiting: tradeWaiting, failed: tradeFailed },
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
