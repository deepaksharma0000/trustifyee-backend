"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initAutoExitWorker = void 0;
const bullmq_1 = require("bullmq");
const Position_model_1 = require("../models/Position.model");
const angel_service_1 = require("../services/angel.service");
const connection = {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: parseInt(process.env.REDIS_PORT || "6379"),
};
const initAutoExitWorker = () => {
    const worker = new bullmq_1.Worker("auto-square-off", async (job) => {
        const { orderId } = job.data;
        console.log(`[AutoExitWorker] Processing exit for ${orderId}`);
        const position = await Position_model_1.Position.findOne({ orderid: orderId });
        if (!position) {
            console.error(`[AutoExitWorker] Position ${orderId} not found`);
            return;
        }
        if (position.status !== "OPEN") {
            console.log(`[AutoExitWorker] Position ${orderId} is already ${position.status}. Skipping.`);
            return;
        }
        // Calculate quantity (logic might need adjustment if partial exits are supported in DB structure)
        // For now assuming position.quantity is the current open quantity or we check if there are partials
        // The requirement says "calculate each user’s current open quantity before exit"
        // In this DB schema, if partial exit happens, quantity is usually updated or a new closed position created.
        // Based on `closeOrder` controller, it uses `position.quantity`.
        const exitSide = position.side === "BUY" ? "SELL" : "BUY";
        try {
            console.log(`[AutoExitWorker] Placing exit order for ${orderId}: ${position.tradingsymbol} ${position.quantity} ${exitSide}`);
            const angelResp = await (0, angel_service_1.placeAngelOrder)({
                clientcode: position.clientcode,
                tradingsymbol: position.tradingsymbol,
                exchange: position.exchange,
                side: exitSide,
                quantity: position.quantity,
                ordertype: "MARKET",
                variety: "NORMAL",
                producttype: "CARRYFORWARD", // Adjust as per your default product type or store in position
            });
            if (!angelResp?.ok) {
                throw new Error(angelResp?.error || "Angel exit order failed");
            }
            position.status = "CLOSED";
            position.exitOrderId = angelResp.resp?.data?.orderid || "AUTO-EXIT";
            position.exitAt = new Date();
            position.autoSquareOffStatus = "COMPLETED";
            await position.save();
            console.log(`[AutoExitWorker] Successfully squared off ${orderId}`);
        }
        catch (err) {
            console.error(`[AutoExitWorker] Failed to square off ${orderId}:`, err);
            position.autoSquareOffStatus = "FAILED";
            await position.save();
            throw err; // Trigger retry
        }
    }, { connection });
    worker.on("completed", (job) => {
        console.log(`[AutoExitWorker] Job ${job.id} completed`);
    });
    worker.on("failed", (job, err) => {
        console.error(`[AutoExitWorker] Job ${job?.id} failed:`, err);
    });
    console.log("[AutoExitWorker] Worker started");
};
exports.initAutoExitWorker = initAutoExitWorker;
