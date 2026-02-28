"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initAutoExitWorker = void 0;
const bullmq_1 = require("bullmq");
const Position_model_1 = require("../models/Position.model");
const angel_service_1 = require("../services/angel.service");
const logger_1 = require("../utils/logger");
const connection = {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: parseInt(process.env.REDIS_PORT || "6379"),
};
const initAutoExitWorker = () => {
    try {
        const worker = new bullmq_1.Worker("auto-square-off", async (job) => {
            const { orderId } = job.data;
            logger_1.log.info(`[AutoExitWorker] Processing exit for ${orderId}`);
            const position = await Position_model_1.Position.findOne({ orderid: orderId });
            if (!position) {
                logger_1.log.error(`[AutoExitWorker] Position ${orderId} not found`);
                return;
            }
            if (position.status !== "OPEN") {
                logger_1.log.info(`[AutoExitWorker] Position ${orderId} is already ${position.status}. Skipping.`);
                return;
            }
            const exitSide = position.side === "BUY" ? "SELL" : "BUY";
            try {
                logger_1.log.info(`[AutoExitWorker] Executing Market Exit for ${orderId}: ${position.tradingsymbol} ${position.quantity} ${exitSide}`);
                const angelResp = await (0, angel_service_1.placeAngelOrder)({
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
                logger_1.log.info(`[AutoExitWorker] Successfully squared off ${orderId}`);
            }
            catch (err) {
                logger_1.log.error(`[AutoExitWorker] Failed to square off ${orderId}:`, err);
                position.autoSquareOffStatus = "FAILED";
                await position.save();
                throw err; // Trigger BullMQ retry
            }
        }, { connection, lockDuration: 30000 });
        worker.on("completed", (job) => {
            logger_1.log.info(`[AutoExitWorker] Job ${job.id} completed`);
        });
        worker.on("failed", (job, err) => {
            logger_1.log.error(`[AutoExitWorker] Job ${job?.id} failed:`, err);
        });
        logger_1.log.info("[AutoExitWorker] Worker started and waiting for jobs...");
    }
    catch (err) {
        logger_1.log.error("[AutoExitWorker] Critical failure starting worker (Redis down?):", err);
    }
};
exports.initAutoExitWorker = initAutoExitWorker;
