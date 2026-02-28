"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutoExitService = void 0;
const bullmq_1 = require("bullmq");
const moment_timezone_1 = __importDefault(require("moment-timezone"));
const logger_1 = require("../utils/logger");
const connection = {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: parseInt(process.env.REDIS_PORT || "6379"),
    enableReadyCheck: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 5000,
};
let autoExitQueue = null;
try {
    autoExitQueue = new bullmq_1.Queue("auto-square-off", {
        connection,
        defaultJobOptions: {
            removeOnComplete: true,
            removeOnFail: false
        }
    });
    autoExitQueue.on('error', (err) => {
        logger_1.log.warn("[AutoExit] Redis is unavailable. System will use MongoDB Polling fallback.");
    });
    logger_1.log.info("[AutoExit] Queue initialized");
}
catch (err) {
    logger_1.log.error("[AutoExit] Critical error initializing queue:", err);
}
class AutoExitService {
    static async scheduleExit(orderId, exitTime) {
        if (!autoExitQueue)
            return undefined;
        const istTime = moment_timezone_1.default.tz(exitTime, "Asia/Kolkata");
        const now = moment_timezone_1.default.tz("Asia/Kolkata");
        const delay = Math.max(0, istTime.diff(now));
        try {
            const addPromise = autoExitQueue.add("exit-position", { orderId }, {
                delay,
                jobId: `exit-${orderId}`,
                attempts: 3,
                backoff: { type: 'exponential', delay: 1000 },
            });
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 2000));
            const job = await Promise.race([addPromise, timeoutPromise]);
            logger_1.log.info(`[AutoExit] Job scheduled in Redis: ${job.id}`);
            return job.id;
        }
        catch (err) {
            logger_1.log.warn(`[AutoExit] Redis push failed (${err.message}). Defaulting to MongoDB Polling fallback.`);
            return undefined; // Silent fallback
        }
    }
    static async cancelExit(orderId) {
        if (!autoExitQueue)
            return;
        const jobId = `exit-${orderId}`;
        try {
            const job = await autoExitQueue.getJob(jobId);
            if (job)
                await job.remove();
        }
        catch (err) {
            // Ignore cancel errors
        }
    }
}
exports.AutoExitService = AutoExitService;
