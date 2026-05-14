import { Worker } from "bullmq";
import { redisBullConnection } from "../utils/redis";
import { placeOrderForClient, fetchBrokerOrder } from "../services/OrderService";
import { SignalExecutionResult } from "../models/SignalExecutionResult";
import { CircuitBreakerService } from "../services/CircuitBreakerService";
import { AlertService } from "../services/AlertService";
import User from "../models/User";
import log from "../utils/logger";
import { getAllTradeQueueNames } from "../utils/tradeQueue";

const toSafeMessage = (error: unknown) => {
  if (!error) return "Unknown execution failure";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
};

export const initTradeExecutionWorker = () => {
  const startWorkerForQueue = (queueName: string) => {
    const worker = new Worker(
      queueName,
      async (job) => {
      const startedAt = Date.now();
      const {
        userId,
        signalId,
        clientOrderId,
        clientCode,
        orderData,
        correlationId,
        outgoingIp: jobOutgoingIp,
        agentUrl: jobAgentUrl,
      } = job.data;

      const logger = log.child({
        worker: "trade-execution",
        queueName,
        queueJobId: job.id,
        jobName: job.name,
        attempt: job.attemptsMade + 1,
        signalId,
        correlationId,
        clientOrderId,
        userId,
      });

      const broker = (orderData?.broker || "ANGELONE").toString().toUpperCase();

      try {
        await SignalExecutionResult.updateOne(
          { clientOrderId },
          {
            $setOnInsert: {
              signalId,
              userId,
              clientOrderId,
              broker,
            },
            $set: {
              status: "QUEUED",
              correlationId,
              executedAt: new Date(),
            },
          },
          { upsert: true }
        );

        const userDoc = await User.findById(userId)
          .select("+outgoing_ip +agent_url +broker_password +broker_totp_secret")
          .lean();

        if (!userDoc) {
          throw new Error(`User ${userId} not found`);
        }

        const outgoingIp =
          jobOutgoingIp && String(jobOutgoingIp).trim() !== ""
            ? String(jobOutgoingIp).trim()
            : userDoc.outgoing_ip || undefined;

        const agentUrl =
          jobAgentUrl && String(jobAgentUrl).trim() !== ""
            ? String(jobAgentUrl).trim()
            : (userDoc as any).agent_url || undefined;

        if (!outgoingIp && !agentUrl) {
          logger.warn(
            "No user-specific outgoing IP/agent configured. Falling back to server network path for broker call."
          );
        }

        if (!(await CircuitBreakerService.isAvailable(broker, "ORDER"))) {
          throw new Error("CIRCUIT_BREAKER_OPEN:ORDER");
        }

        const existingExecution = await SignalExecutionResult.findOne({ clientOrderId }).lean();
        if (existingExecution?.status === "SUCCESS") {
          logger.info("Execution already marked SUCCESS, skipping duplicate processing.");
          return;
        }

        try {
          const existingOrder = await fetchBrokerOrder(
            userId,
            clientCode,
            clientOrderId,
            outgoingIp
          );

          if (existingOrder && (existingOrder.status === "COMPLETE" || existingOrder.status === "OPEN")) {
            logger.warn("Broker already has order for this clientOrderId. Synchronizing instead of placing duplicate order.");
            await SignalExecutionResult.updateOne(
              { clientOrderId },
              {
                status: "SUCCESS",
                orderId: existingOrder.orderid,
                executedAt: new Date(),
                errorMessage: undefined,
              }
            );
            return;
          }
        } catch (checkErr) {
          logger.debug("Broker idempotency check could not confirm an existing order. Continuing fresh placement.", checkErr);
        }

        const resp = await placeOrderForClient(userId, clientCode, {
          ...orderData,
          clientOrderId,
          outgoingIp,
          agentUrl,
        });

        const orderId = resp?.data?.orderid || resp?.data?.data?.orderid;
        const brokerMessage = String(resp?.data?.message || resp?.message || "");
        const loweredMessage = brokerMessage.toLowerCase();
        const isRejectedMessage =
          loweredMessage.includes("reject") ||
          loweredMessage.includes("failed") ||
          loweredMessage.includes("error") ||
          loweredMessage.includes("invalid");

        const isRealSuccess =
          Boolean(orderId) &&
          (resp?.status === 200 || resp?.ok === true || resp?.status === true) &&
          !isRejectedMessage;

        const { BrokerResponse } = await import("../models/BrokerResponse");
        await BrokerResponse.create({
          userId,
          clientcode: clientCode || "UNKNOWN",
          tradingsymbol: orderData?.tradingsymbol || "UNKNOWN",
          orderid: orderId || "REJECTED",
          action: "PLACE_ORDER",
          status: isRealSuccess ? "SUCCESS" : "REJECTED",
          message: isRealSuccess ? "Order placed successfully" : brokerMessage || "Order rejected by broker",
          brokerError: isRealSuccess ? undefined : resp?.data || resp,
        });

        if (!isRealSuccess) {
          throw new Error(brokerMessage || "Order failed at broker");
        }

        await SignalExecutionResult.updateOne(
          { clientOrderId },
          {
            status: "SUCCESS",
            orderId,
            executedAt: new Date(),
            errorMessage: undefined,
          }
        );

        await CircuitBreakerService.recordSuccess(broker, "ORDER");
        logger.info("Trade execution successful", { orderId });
      } catch (error: any) {
        const message = toSafeMessage(error);

        logger.error("Trade execution failed", {
          error: message,
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts.attempts,
        });

        await SignalExecutionResult.updateOne(
          { clientOrderId },
          {
            $set: {
              status: "FAILED",
              errorMessage: message,
              executedAt: new Date(),
              correlationId,
            },
          }
        ).catch((updateErr) => {
          logger.error("Failed to persist execution failure status", updateErr);
        });

        try {
          const { BrokerResponse } = await import("../models/BrokerResponse");
          await BrokerResponse.create({
            userId,
            clientcode: clientCode || "UNKNOWN",
            tradingsymbol: orderData?.tradingsymbol || "UNKNOWN",
            orderid: "REJECTED",
            action: "PLACE_ORDER",
            status: "REJECTED",
            message,
            brokerError: {
              error: message,
              stack: error?.stack,
            },
          });
        } catch (brokerLogErr) {
          logger.error("Failed to log broker rejection payload", brokerLogErr);
        }

        await CircuitBreakerService.recordFailure(broker, "ORDER").catch((cbErr) => {
          logger.error("Failed to update circuit breaker failure counter", cbErr);
        });

        if (job.attemptsMade + 1 >= Number(job.opts.attempts || 1)) {
          await AlertService.trigger(
            "TRADE_MAX_RETRIES",
            `Trade for user ${userId} failed after ${job.attemptsMade + 1} attempts. Error: ${message}`,
            "CRITICAL"
          );
        }

        throw error;
      } finally {
        logger.info("Trade execution job finished", { durationMs: Date.now() - startedAt });
      }
      },
      {
        connection: redisBullConnection as any,
        concurrency: 5,
        limiter: { max: 9, duration: 1000 },
      }
    );

    worker.on("error", (err) => {
      log.error("[TradeExecutionWorker] Worker error", { queueName, err });
    });

    worker.on("failed", (job, err) => {
      log.error("[TradeExecutionWorker] Job failed", {
        queueName,
        queueJobId: job?.id,
        name: job?.name,
        attemptsMade: job?.attemptsMade,
        error: err?.message,
      });
    });

    worker.on("completed", (job) => {
      log.info("[TradeExecutionWorker] Job completed", {
        queueName,
        queueJobId: job.id,
        name: job.name,
      });
    });

    log.info("[TradeExecutionWorker] Worker started", { queueName });
  };

  const queueNames = getAllTradeQueueNames();
  queueNames.forEach((queueName) => startWorkerForQueue(queueName));
};
