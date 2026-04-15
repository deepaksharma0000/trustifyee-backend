import { Queue } from "bullmq";
import moment from "moment-timezone";
import { Position } from "../models/Position.model";
import log from "../utils/logger";

const connection = {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: parseInt(process.env.REDIS_PORT || "6379"),
    enableReadyCheck: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 5000,
};

let autoExitQueue: Queue | null = null;

try {
    autoExitQueue = new Queue("auto-square-off", {
        connection,
        defaultJobOptions: {
            removeOnComplete: true,
            removeOnFail: false
        }
    });

    autoExitQueue.on('error', (err) => {
        log.warn("[AutoExit] Redis is unavailable. System will use MongoDB Polling fallback.");
    });

    log.info("[AutoExit] Queue initialized");
} catch (err) {
    log.error("[AutoExit] Critical error initializing queue:", err);
}

export class AutoExitService {
    static async scheduleExit(orderId: string, exitTime: Date | string): Promise<string | undefined> {
        if (!autoExitQueue) return undefined;

        const istTime = moment.tz(exitTime, "Asia/Kolkata");
        const now = moment.tz("Asia/Kolkata");
        const delay = Math.max(0, istTime.diff(now));

        try {
            const addPromise = autoExitQueue.add(
                "exit-position",
                { orderId },
                {
                    delay,
                    jobId: `exit-${orderId}`,
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 1000 },
                }
            );

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Timeout")), 2000)
            );

            const job = await Promise.race([addPromise, timeoutPromise]) as any;
            log.info(`[AutoExit] Job scheduled in Redis: ${job.id}`);
            return job.id;
        } catch (err: any) {
            log.warn(`[AutoExit] Redis push failed (${err.message}). Defaulting to MongoDB Polling fallback.`);
            return undefined; // Silent fallback
        }
    }

    static async cancelExit(orderId: string) {
        if (!autoExitQueue) return;
        const jobId = `exit-${orderId}`;
        try {
            const job = await autoExitQueue.getJob(jobId);
            if (job) await job.remove();
        } catch (err) {
            // Ignore cancel errors
        }
    }
}
