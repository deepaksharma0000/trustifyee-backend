// src/utils/redis.ts
import Redis from "ioredis";
import { config } from "../config";
import log from "./logger";

const redisConfig = {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: parseInt(process.env.REDIS_PORT || "6379"),
    maxRetriesPerRequest: null, // Required for BullMQ
};

export const redisConnection = new Redis(redisConfig);

redisConnection.on("connect", () => log.info("✅ Redis Connected"));
redisConnection.on("error", (err) => log.error("❌ Redis Error:", err));

export default redisConnection;
