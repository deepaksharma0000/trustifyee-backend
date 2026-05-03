// src/jobs/TradeExecutionWorker.ts
import { Worker } from "bullmq";
import { redisConnection } from "../utils/redis";
import { placeOrderForClient, fetchBrokerOrder } from "../services/OrderService";
import { SignalExecutionResult } from "../models/SignalExecutionResult";
import { CircuitBreakerService } from "../services/CircuitBreakerService";
import { AlertService } from "../services/AlertService";
import log from "../utils/logger";

export const initTradeExecutionWorker = () => {
    const worker = new Worker(
        "trade-execution",
        async (job) => {
            const { userId, signalId, clientOrderId, clientCode, orderData, correlationId } = job.data;
            const logger = log.child({ correlationId, clientOrderId, userId });
            const broker = orderData.broker || "ANGELONE";

            // 🛡️ 1. CIRCUIT BREAKER CHECK (Granular: ORDER API)
            if (!(await CircuitBreakerService.isAvailable(broker, "ORDER"))) {
                throw new Error("CIRCUIT_BREAKER_OPEN:ORDER");
            }

            try {
                // 🛡️ 2. FETCH DB STATE
                const execution = await SignalExecutionResult.findOne({ clientOrderId });
                if (execution?.status === "SUCCESS") return;

                // 🛡️ 3. BROKER CRASH SAFETY CHECK (Check if order already exists at broker)
                // This handles cases where worker crashed AFTER broker call but BEFORE DB update.
                try {
                    const existingOrder = await fetchBrokerOrder(userId, clientCode, clientOrderId);
                    if (existingOrder && (existingOrder.status === "COMPLETE" || existingOrder.status === "OPEN")) {
                        logger.warn("Order already exists at broker. Synchronizing state instead of re-trading.");
                        await SignalExecutionResult.updateOne(
                            { clientOrderId },
                            { status: "SUCCESS", orderId: existingOrder.orderid, executedAt: new Date() }
                        );
                        return;
                    }
                } catch (err) {
                    // Ignore "Order Not Found" errors from broker, proceed to place order
                    logger.debug("Order not found at broker, proceeding with fresh placement.");
                }

                // 🛡️ 4. EXECUTE BROKER ORDER
                const resp = await placeOrderForClient(userId, clientCode, {
                    ...orderData,
                    clientOrderId
                });

                const orderId = resp?.data?.orderid || resp?.data?.data?.orderid;
                
                // 🛡️ 5. LOG BROKER RESPONSE (For User Transparency)
                const { BrokerResponse } = await import("../models/BrokerResponse");
                const isRealSuccess = !!orderId && (resp.status === 200 || resp.ok === true);

                await BrokerResponse.create({
                    userId,
                    clientcode: clientCode || "UNKNOWN",
                    tradingsymbol: orderData.tradingsymbol,
                    orderid: orderId || "REJECTED",
                    action: "PLACE_ORDER",
                    status: isRealSuccess ? "SUCCESS" : "REJECTED",
                    message: isRealSuccess ? "Order placed successfully" : (resp?.message || resp?.data?.message || "Order rejected by broker"),
                    brokerError: !isRealSuccess ? (resp?.data || resp) : undefined
                });

                if (!isRealSuccess) throw new Error(resp?.message || resp?.data?.message || "Order failed at broker");

                // 🛡️ 6. COMMIT SUCCESS
                await SignalExecutionResult.updateOne(
                    { clientOrderId },
                    { status: "SUCCESS", orderId, executedAt: new Date() }
                );

                await CircuitBreakerService.recordSuccess(broker, "ORDER");
                logger.info(`Trade success: ${orderId}`);

            } catch (err: any) {
                logger.error(`Execution failed: ${err.message}`);
                
                // 🛡️ LOG FAILURE TO BROKER RESPONSE
                try {
                    const { BrokerResponse } = await import("../models/BrokerResponse");
                    await BrokerResponse.create({
                        userId,
                        clientcode: clientCode || "UNKNOWN",
                        tradingsymbol: orderData?.tradingsymbol || "UNKNOWN",
                        orderid: "REJECTED",
                        action: "PLACE_ORDER",
                        status: "REJECTED",
                        message: err.message || "Order rejected by broker",
                        brokerError: { error: err.message }
                    });
                } catch (logErr) { /* Ignore logging errors */ }

                if (job.attemptsMade >= 3) {
                    await AlertService.trigger("TRADE_MAX_RETRIES", `Trade for user ${userId} failed after ${job.attemptsMade} attempts. Error: ${err.message}`, "CRITICAL");
                }

                throw err;
            }
        },
        {
            connection: redisConnection as any,
            concurrency: 5,
            limiter: { max: 9, duration: 1000 },
        }
    );
};
