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

redisConnection.on("connect", async () => {
    log.info("✅ Redis Connected");
    try {
        const info = await redisConnection.info('server');
        const versionMatch = info.match(/redis_version:(\S+)/);
        if (versionMatch) {
            const version = versionMatch[1];
            const [major, minor] = version.split('.').map(Number);
            if (major < 6 || (major === 6 && minor < 2)) {
                log.warn(`⚠️ Redis ${version} detected. BullMQ requires 6.2+. Upgrade Redis to avoid issues.`);
                log.warn(`   Download: https://github.com/tporadowski/redis/releases (Windows)`);
            }
        }
    } catch (err) {
        log.error("Error checking Redis version:", err);
    }
});
redisConnection.on("error", (err) => log.error("❌ Redis Error:", err));

export default redisConnection;
