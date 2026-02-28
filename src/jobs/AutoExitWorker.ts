import { Worker } from "bullmq";
import { Position } from "../models/Position.model";
import { placeAngelOrder } from "../services/angel.service";
import { log } from "../utils/logger";

const connection = {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: parseInt(process.env.REDIS_PORT || "6379"),
};

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

                    const angelResp = await placeAngelOrder({
                        clientcode: position.clientcode,
                        tradingsymbol: position.tradingsymbol,
                        exchange: position.exchange,
                        side: exitSide,
                        quantity: position.quantity,
                        ordertype: "MARKET",
                        variety: "NORMAL",
                        producttype: position.productType || "CARRYFORWARD",
                    });

                    if (!angelResp?.ok) {
                        throw new Error(angelResp?.error || "Broker exit order failed");
                    }

                    position.status = "CLOSED";
                    position.exitOrderId = angelResp.resp?.data?.orderid || "AUTO-EXIT";
                    position.exitQty = position.quantity;
                    position.exitAt = new Date();
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
            { connection, lockDuration: 30000 }
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
