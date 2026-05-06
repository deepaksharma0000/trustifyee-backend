// src/services/CircuitBreakerService.ts
import redis from "../utils/redis";
import log from "../utils/logger";
import { AlertService } from "./AlertService";
import { config } from "../config";

export type CB_RESOURCE = "ORDER" | "LTP" | "AUTH";

export class CircuitBreakerService {
    private static THRESHOLD = config.circuitBreakerThreshold;
    private static RESET_TIMEOUT = 30;

    static async recordFailure(broker: string, resource: CB_RESOURCE) {
        const key = `CB:FAILURES:${broker}:${resource}`;
        const count = await redis.incr(key);
        if (count === 1) await redis.expire(key, 60);

        if (count >= this.THRESHOLD) {
            await redis.set(`CB:STATE:${broker}:${resource}`, "OPEN", "EX", this.RESET_TIMEOUT);
            
            await AlertService.trigger(
                "CIRCUIT_BREAKER_OPEN", 
                `Circuit Breaker OPEN for ${broker} [${resource}]. API calls paused.`,
                "CRITICAL"
            );
        }
    }

    static async recordSuccess(broker: string, resource: CB_RESOURCE) {
        await redis.del(`CB:FAILURES:${broker}:${resource}`);
        await redis.del(`CB:STATE:${broker}:${resource}`);
    }

    static async isAvailable(broker: string, resource: CB_RESOURCE): Promise<boolean> {
        const state = await redis.get(`CB:STATE:${broker}:${resource}`);
        return state !== "OPEN";
    }
}
