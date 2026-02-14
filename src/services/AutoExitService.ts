import { Queue } from "bullmq";
import { Position } from "../models/Position.model";

const connection = {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: parseInt(process.env.REDIS_PORT || "6379"),
};

export const autoExitQueue = new Queue("auto-square-off", { connection });

export class AutoExitService {
    static async scheduleExit(orderId: string, exitTime: Date) {
        if (exitTime <= new Date()) {
            console.log(`[AutoExit] Exit time ${exitTime} is in the past for ${orderId}. Executing immediately.`);
        }

        const delay = Math.max(0, exitTime.getTime() - new Date().getTime());

        const job = await autoExitQueue.add(
            "exit-position",
            { orderId },
            {
                delay,
                jobId: `exit-${orderId}`, // Deduplication
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 1000,
                },
            }
        );

        console.log(`[AutoExit] Scheduled exit for ${orderId} at ${exitTime} (Job ID: ${job.id})`);
        return job.id;
    }

    static async cancelExit(orderId: string) {
        const jobId = `exit-${orderId}`;
        const job = await autoExitQueue.getJob(jobId);
        if (job) {
            await job.remove();
            console.log(`[AutoExit] Cancelled exit job for ${orderId}`);
        }
    }
}
