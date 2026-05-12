import { Worker } from "bullmq";
import { Position } from "../models/Position.model";
import { closeAngelOrder } from "../services/angel.service";
import log from "../utils/logger";
import { redisBullConnection } from "../utils/redis";

export const initAutoExitWorker = () => {
    try {
        const worker = new Worker(
            "auto-square-off",
            async (job) => {
                const { orderId } = job.data;
                log.info(`[AutoExitWorker] Processing exit for ${orderId}`);

                const position = await Position.findOne({ orderid: orderId });

                if (!position) {
                    log.error(`[AutoExitWorker] Position ${orderId} not found`);
                    return;
                }

                if (position.status !== "OPEN") {
                    log.info(`[AutoExitWorker] Position ${orderId} is already ${position.status}. Skipping.`);
                    return;
                }

                const exitSide = position.side === "BUY" ? "SELL" : "BUY";

                try {
                    log.info(`[AutoExitWorker] Executing Market Exit for ${orderId}: ${position.tradingsymbol} ${position.quantity} ${exitSide}`);

                    const angelResp = await closeAngelOrder(
                        position.clientcode,
                        position.orderid
                    );

                    if (!angelResp?.ok) {
                        throw new Error(angelResp?.message || "Broker exit order failed");
                    }

                    // Note: /api/orders/close already updates position status and exit details in DB.
                    // We just update the job status here.
                    position.autoSquareOffStatus = "COMPLETED";
                    await position.save();
                    log.info(`[AutoExitWorker] Successfully squared off ${orderId}`);

                } catch (err: any) {
                    log.error(`[AutoExitWorker] Failed to square off ${orderId}:`, err);
                    position.autoSquareOffStatus = "FAILED";
                    await position.save();
                    throw err; // Trigger BullMQ retry
                }
            },
            { connection: redisBullConnection as any, lockDuration: 30000 }
        );

        worker.on("completed", (job) => {
            log.info(`[AutoExitWorker] Job ${job.id} completed`);
        });

        worker.on("failed", (job, err) => {
            log.error(`[AutoExitWorker] Job ${job?.id} failed:`, err);
        });

        log.info("[AutoExitWorker] Worker started and waiting for jobs...");
    } catch (err) {
        log.error("[AutoExitWorker] Critical failure starting worker (Redis down?):", err);
    }
};
