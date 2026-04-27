import { Worker, Queue } from "bullmq";
import { Position } from "../models/Position.model";
import { placeOrderForClient } from "../services/OrderService";
import { SignalExecutionResult } from "../models/SignalExecutionResult";
import User from "../models/User";
import log from "../utils/logger";

const connection = {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: parseInt(process.env.REDIS_PORT || "6379"),
};

/**
 * Trade Execution Worker
 * Consumes signals and places orders via backend with Static IP binding
 */
export const initTradeExecutionWorker = () => {
    try {
        const worker = new Worker(
            "trade-execution",
            async (job) => {
                const { userId, signalId, orderData } = job.data;
                log.info(`[TradeWorker] Processing trade for user ${userId}, signal ${signalId}`);

                const user = await User.findById(userId);
                if (!user) throw new Error("User not found");

                try {
                    // Place order via server-side OrderService (now unblocked)
                    const resp = await placeOrderForClient(userId, user.client_key!, {
                        ...orderData,
                        strategyId: user.lot_multipliers?.get(orderData.strategy) || orderData.strategy // Example mapping
                    });

                    const orderId = resp?.data?.orderid || resp?.data?.data?.orderid || `SIG-${Date.now()}`;

                    // Log Audit Trail
                    await SignalExecutionResult.create({
                        signalId,
                        userId,
                        broker: user.broker || "ANGELONE",
                        orderId: orderId,
                        status: "SUCCESS",
                        executedAt: new Date(),
                        ipAddress: process.env.PUBLIC_IP || "SERVER_STATIC_IP"
                    });

                    log.info(`[TradeWorker] SUCCESS: Order ${orderId} placed for ${user.user_name}`);

                } catch (err: any) {
                    log.error(`[TradeWorker] FAILED for ${user.user_name}:`, err.message);
                    
                    await SignalExecutionResult.create({
                        signalId,
                        userId,
                        broker: user.broker || "ANGELONE",
                        status: "FAILED",
                        errorMessage: err.message,
                        executedAt: new Date(),
                        ipAddress: process.env.PUBLIC_IP || "SERVER_STATIC_IP"
                    });

                    throw err; // Trigger BullMQ retry
                }
            },
            { 
                connection, 
                lockDuration: 30000,
                limiter: {
                    max: 9, // AngelOne 9 orders/sec limit
                    duration: 1000
                }
            }
        );

        worker.on("completed", (job) => log.debug(`[TradeWorker] Job ${job.id} done`));
        worker.on("failed", (job, err) => log.error(`[TradeWorker] Job ${job?.id} failed:`, err));

        log.info("[TradeWorker] Trade Execution Worker started (Rate Limit: 9 OPS)");
    } catch (err) {
        log.error("[TradeWorker] Critical failure starting worker:", err);
    }
};

export const tradeQueue = new Queue("trade-execution", { connection });
