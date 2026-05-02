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
            const cbStates: Record<string, string> = {};
            
            for (const b of activeBrokers) {
                const state = await redis.get(`CB:STATE:${b}`) || "CLOSED";
                cbStates[b] = state;
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
