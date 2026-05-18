// src/services/GlobalRateLimiter.ts
import Redis from "ioredis";
import { redisBullConnection } from "../utils/redis";
import log from "../utils/logger";

export type PriorityClass = "CRITICAL_EXIT" | "STOP_LOSS_EXIT" | "MANUAL_EXIT" | "ENTRY" | "ANALYTICS";

export class GlobalRateLimiter {
  private static instance: GlobalRateLimiter;
  private redis: Redis;

  // Configuration thresholds
  private readonly BUCKET_CAPACITY = 3;      // Standard maximum capacity (3 req/sec)
  private readonly REFILL_RATE = 3;          // Tokens per second
  private readonly RESERVED_EXIT_POOL = 2;   // Extra emergency buffer pool specifically for exit signals

  private constructor() {
    this.redis = new Redis(redisBullConnection as any);
    this.redis.on("error", (err) => log.error("[RateLimiter] Redis Connection Error:", err));
  }

  public static getInstance(): GlobalRateLimiter {
    if (!GlobalRateLimiter.instance) {
      GlobalRateLimiter.instance = new GlobalRateLimiter();
    }
    return GlobalRateLimiter.instance;
  }

  /**
   * Distributed Priority-Aware Token Bucket reservation validator.
   * Ensures that critical liquidations and stop-loss actions are guaranteed execution capacity.
   */
  async acquire(apiKeyFingerprint: string, priority: PriorityClass): Promise<boolean> {
    const key = `ratelimit:bucket:${apiKeyFingerprint}`;
    const reservedKey = `ratelimit:reserved:${apiKeyFingerprint}`;
    const now = Date.now();

    // 1. Bypass check: Critical exits bypass standard token limits or utilize emergency buffers
    if (priority === "CRITICAL_EXIT" || priority === "STOP_LOSS_EXIT") {
      const allowed = await this.consumeReservedTokens(reservedKey, now);
      if (allowed) {
        log.debug(`[RateLimiter] Emergency Exit Bypass granted for priority ${priority}`);
        return true;
      }
      // If even reserved exits are exhausted, we let it fallback to normal pool but prioritize it
      return this.consumeNormalTokens(key, now, true);
    }

    // 2. Normal priority operations (Entries, Manual exits, Analytics)
    return this.consumeNormalTokens(key, now, false);
  }

  private async consumeReservedTokens(key: string, now: number): Promise<boolean> {
    // Pipeline transactional token refill and deduction for reserved emergency pool
    const result = await this.redis.eval(
      `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local capacity = tonumber(ARGV[2])
      local refill_rate = tonumber(ARGV[3])

      local data = redis.call("HMGET", key, "tokens", "last_refill")
      local tokens = tonumber(data[1])
      local last_refill = tonumber(data[2])

      if not tokens then
        tokens = capacity
        last_refill = now
      else
        local delta = math.max(0, (now - last_refill) / 1000)
        tokens = math.min(capacity, tokens + delta * refill_rate)
        last_refill = now
      end

      if tokens >= 1 then
        tokens = tokens - 1
        redis.call("HMSET", key, "tokens", tokens, "last_refill", last_refill)
        return 1
      else
        redis.call("HMSET", key, "tokens", tokens, "last_refill", last_refill)
        return 0
      end
      `,
      1,
      key,
      now.toString(),
      this.RESERVED_EXIT_POOL.toString(),
      this.REFILL_RATE.toString()
    );

    return result === 1;
  }

  private async consumeNormalTokens(key: string, now: number, isHighPriority: boolean): Promise<boolean> {
    const result = await this.redis.eval(
      `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local capacity = tonumber(ARGV[2])
      local refill_rate = tonumber(ARGV[3])
      local is_high_priority = tonumber(ARGV[4])

      local data = redis.call("HMGET", key, "tokens", "last_refill")
      local tokens = tonumber(data[1])
      local last_refill = tonumber(data[2])

      if not tokens then
        tokens = capacity
        last_refill = now
      else
        local delta = math.max(0, (now - last_refill) / 1000)
        tokens = math.min(capacity, tokens + delta * refill_rate)
        last_refill = now
      end

      -- If high priority exit and bucket is empty, allow borrowing 1 token to prevent execution starvation
      if tokens >= 1 or (is_high_priority == 1 and tokens > -1) then
        tokens = tokens - 1
        redis.call("HMSET", key, "tokens", tokens, "last_refill", last_refill)
        return 1
      else
        redis.call("HMSET", key, "tokens", tokens, "last_refill", last_refill)
        return 0
      end
      `,
      1,
      key,
      now.toString(),
      this.BUCKET_CAPACITY.toString(),
      this.REFILL_RATE.toString(),
      (isHighPriority ? 1 : 0).toString()
    );

    return result === 1;
  }
}

export const globalRateLimiter = GlobalRateLimiter.getInstance();
