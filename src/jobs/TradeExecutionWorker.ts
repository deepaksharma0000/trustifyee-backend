// src/jobs/TradeExecutionWorker.ts
import { Worker } from "bullmq";
import { redisConnection } from "../utils/redis";
import { placeOrderForClient, fetchBrokerOrder } from "../services/OrderService";
import { SignalExecutionResult } from "../models/SignalExecutionResult";
import { CircuitBreakerService } from "../services/CircuitBreakerService";
import { AlertService } from "../services/AlertService";
import User from "../models/User";
import log from "../utils/logger";

export const initTradeExecutionWorker = () => {
    const worker = new Worker(
        "trade-execution",
        async (job) => {
            const { userId, signalId, clientOrderId, clientCode, orderData, correlationId, outgoingIp: jobOutgoingIp } = job.data;
            const logger = log.child({ correlationId, clientOrderId, userId });
            
            // 🛡️ 1. Fetch user from MongoDB with sensitive fields
            const userDoc = await User.findById(userId).select('+outgoing_ip +broker_password +broker_totp_secret').lean();
            if (!userDoc) throw new Error(`User ${userId} not found`);

            // 🛡️ 2. SEBI COMPLIANCE: Static IP Guard
            // Every user must trade via their registered static IP. No fallback to server IP.
            const outgoingIp = (jobOutgoingIp && String(jobOutgoingIp).trim() !== "") ? jobOutgoingIp : (userDoc.outgoing_ip || "");
            
            if (!outgoingIp || String(outgoingIp).trim() === "") {
                const ipError = "User static IP not registered. Please contact admin.";
                logger.error(`[SEBI_VIOLATION] Trade BLOCKED for ${userDoc.user_name || userDoc.email}: ${ipError}`);
                
                // Record failure in DB before throwing
                const { BrokerResponse } = await import("../models/BrokerResponse");
                await BrokerResponse.create({
                    userId,
                    clientcode: clientCode || "UNKNOWN",
                    tradingsymbol: orderData?.tradingsymbol || "UNKNOWN",
                    orderid: "BLOCKED_IP",
                    action: "PLACE_ORDER",
                    status: "REJECTED",
                    message: ipError
                });

                throw new Error(ipError);
            }

            const broker = orderData.broker || userDoc.broker || "ANGELONE";

            // 🛡️ 3. CIRCUIT BREAKER CHECK (Granular: ORDER API)
            if (!(await CircuitBreakerService.isAvailable(broker, "ORDER"))) {
                throw new Error("CIRCUIT_BREAKER_OPEN:ORDER");
            }

            try {
                // 🛡️ 2. FETCH DB STATE
                const execution = await SignalExecutionResult.findOne({ clientOrderId });
                if (execution?.status === "SUCCESS") return;

                // 🛡️ 3. BROKER CRASH SAFETY CHECK (Check if order already exists at broker)
                try {
                    const existingOrder = await fetchBrokerOrder(userId, clientCode, clientOrderId, outgoingIp);
                    if (existingOrder && (existingOrder.status === "COMPLETE" || existingOrder.status === "OPEN")) {
                        logger.warn("Order already exists at broker. Synchronizing state instead of re-trading.");
                        await SignalExecutionResult.updateOne(
                            { clientOrderId },
                            { status: "SUCCESS", orderId: existingOrder.orderid, executedAt: new Date() }
                        );
                        return;
                    }
                } catch (err) {
                    logger.debug("Order not found at broker, proceeding with fresh placement.");
                }

                // 🛡️ 4. EXECUTE BROKER ORDER (Pass outgoingIp)
                const resp = await placeOrderForClient(userId, clientCode, {
                    ...orderData,
                    clientOrderId,
                    outgoingIp // ← ADDED AS PER FIX 1
                });

                const orderId = resp?.data?.orderid || resp?.data?.data?.orderid;
                
                // 🛡️ 5. LOG BROKER RESPONSE (For User Transparency)
                const { BrokerResponse } = await import("../models/BrokerResponse");

                // 🛡️ FIX 4: STRICTER SUCCESS VALIDATION
                const brokerMessage = resp?.data?.message || resp?.message || "";
                const isRejectedMessage = brokerMessage.toLowerCase().includes("reject") ||
                    brokerMessage.toLowerCase().includes("failed") ||
                    brokerMessage.toLowerCase().includes("error") ||
                    brokerMessage.toLowerCase().includes("invalid");
                
                const isRealSuccess = !!orderId && 
                    (resp.status === 200 || resp.ok === true) && 
                    !isRejectedMessage;

                await BrokerResponse.create({
                    userId,
                    clientcode: clientCode || "UNKNOWN",
                    tradingsymbol: orderData.tradingsymbol,
                    orderid: orderId || "REJECTED",
                    action: "PLACE_ORDER",
                    status: isRealSuccess ? "SUCCESS" : "REJECTED",
                    message: isRealSuccess ? "Order placed successfully" : (brokerMessage || "Order rejected by broker"),
                    brokerError: !isRealSuccess ? (resp?.data || resp) : undefined
                });

                if (!isRealSuccess) throw new Error(brokerMessage || "Order failed at broker");

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
