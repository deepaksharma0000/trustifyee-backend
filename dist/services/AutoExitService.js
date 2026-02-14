"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutoExitService = exports.autoExitQueue = void 0;
const bullmq_1 = require("bullmq");
const connection = {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: parseInt(process.env.REDIS_PORT || "6379"),
};
exports.autoExitQueue = new bullmq_1.Queue("auto-square-off", { connection });
class AutoExitService {
    static async scheduleExit(orderId, exitTime) {
        if (exitTime <= new Date()) {
            console.log(`[AutoExit] Exit time ${exitTime} is in the past for ${orderId}. Executing immediately.`);
        }
        const delay = Math.max(0, exitTime.getTime() - new Date().getTime());
        const job = await exports.autoExitQueue.add("exit-position", { orderId }, {
            delay,
            jobId: `exit-${orderId}`, // Deduplication
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 1000,
            },
        });
        console.log(`[AutoExit] Scheduled exit for ${orderId} at ${exitTime} (Job ID: ${job.id})`);
        return job.id;
    }
    static async cancelExit(orderId) {
        const jobId = `exit-${orderId}`;
        const job = await exports.autoExitQueue.getJob(jobId);
        if (job) {
            await job.remove();
            console.log(`[AutoExit] Cancelled exit job for ${orderId}`);
        }
    }
}
exports.AutoExitService = AutoExitService;
