import { Worker } from "bullmq";
import { redisBullConnection } from "../utils/redis";
import { placeOrderForClient, fetchBrokerOrder } from "../services/OrderService";
import { SignalExecutionResult } from "../models/SignalExecutionResult";
import { CircuitBreakerService } from "../services/CircuitBreakerService";
import { AlertService } from "../services/AlertService";
import User from "../models/User";
import log from "../utils/logger";
import { getAllTradeQueueNames } from "../utils/tradeQueue";
import { config } from "../config";

const toSafeMessage = (error: unknown) => {
  if (!error) return "Unknown execution failure";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
};

const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;

const normalizeIpv4 = (value?: string): string => {
  const trimmed = String(value || "").trim();
  return IPV4_REGEX.test(trimmed) ? trimmed : "";
};

const resolveNetworkMeta = (outgoingIp?: string, agentUrl?: string, dedicatedIpEnabled = false) => {
  const localBindingEnabled = process.env.ANGEL_ENABLE_LOCAL_BINDING === "true";
  const normalizedOutgoingIp = normalizeIpv4(outgoingIp);
  const normalizedPublicIp = normalizeIpv4(config.publicIp);
  const normalizedAgentUrl = String(agentUrl || "").trim();
  const dedicatedRoutingEnabled = dedicatedIpEnabled || Boolean(normalizedOutgoingIp || normalizedAgentUrl);

  if (config.forceSharedVpsRoute && !dedicatedRoutingEnabled) {
    return {
      usedIp: normalizedPublicIp || null,
      usedIpLabel: normalizedPublicIp || "UNKNOWN",
      routeType: "SERVER_SHARED_IP",
      agentUrl: null,
    };
  }

  if (normalizedAgentUrl) {
    return {
      usedIp: normalizedOutgoingIp || null,
      usedIpLabel: normalizedOutgoingIp || "AGENT_ROUTE",
      routeType: "AGENT_ROUTE",
      agentUrl: normalizedAgentUrl,
    };
  }

  if (normalizedOutgoingIp && !localBindingEnabled) {
    return {
      usedIp: normalizedPublicIp || null,
      usedIpLabel: normalizedPublicIp || "UNKNOWN",
      routeType: "SERVER_SHARED_IP",
      agentUrl: null,
    };
  }

  if (normalizedOutgoingIp) {
    return {
      usedIp: normalizedOutgoingIp,
      usedIpLabel: normalizedOutgoingIp,
      routeType: "USER_STATIC_IP",
      agentUrl: null,
    };
  }

  if (normalizedPublicIp) {
    return {
      usedIp: normalizedPublicIp,
      usedIpLabel: normalizedPublicIp,
      routeType: "SERVER_SHARED_IP",
      agentUrl: null,
    };
  }

  return {
    usedIp: null,
    usedIpLabel: "UNKNOWN",
    routeType: "UNKNOWN",
    agentUrl: null,
  };
};

const withIpHint = (message: string, usedIpLabel: string) => {
  const baseMessage = String(message || "").trim() || "Order rejected by broker";
  const lowered = baseMessage.toLowerCase();
  const isIpRelatedRejection =
    lowered.includes("unregistered ip") ||
    lowered.includes("register your ip") ||
    lowered.includes("static ip");

  if (!isIpRelatedRejection) return baseMessage;
  if (lowered.includes("used ip:")) return baseMessage;

  return `${baseMessage} | Used IP: ${usedIpLabel}`;
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
        dedicatedIpEnabled: jobDedicatedIpEnabled,
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

      let networkMeta = resolveNetworkMeta(
        jobOutgoingIp,
        jobAgentUrl,
        Boolean(jobDedicatedIpEnabled)
      );

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
          .select("+outgoing_ip +agent_url +broker_password +broker_totp_secret dedicated_ip_enabled")
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
        const dedicatedIpEnabled =
          Boolean(jobDedicatedIpEnabled) || Boolean((userDoc as any)?.dedicated_ip_enabled === true);

        networkMeta = resolveNetworkMeta(outgoingIp, agentUrl, dedicatedIpEnabled);

        await SignalExecutionResult.updateOne(
          { clientOrderId },
          {
            $set: {
              ipAddress: networkMeta.usedIpLabel,
            },
          }
        );

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
                ipAddress: networkMeta.usedIpLabel,
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
          dedicatedIpEnabled,
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
        const rejectedMessage = withIpHint(
          brokerMessage || "Order rejected by broker",
          networkMeta.usedIpLabel
        );
        await BrokerResponse.create({
          userId,
          clientcode: clientCode || "UNKNOWN",
          tradingsymbol: orderData?.tradingsymbol || "UNKNOWN",
          orderid: orderId || "REJECTED",
          action: "PLACE_ORDER",
          status: isRealSuccess ? "SUCCESS" : "REJECTED",
          message: isRealSuccess ? "Order placed successfully" : rejectedMessage,
          usedIp: networkMeta.usedIp,
          networkRoute: networkMeta.routeType,
          brokerError: isRealSuccess
            ? undefined
            : {
                ...(resp?.data || resp || {}),
                usedIp: networkMeta.usedIpLabel,
                networkRoute: networkMeta.routeType,
                agentUrl: networkMeta.agentUrl,
              },
        });

        if (!isRealSuccess) {
          throw new Error(rejectedMessage);
        }

        await SignalExecutionResult.updateOne(
          { clientOrderId },
          {
            status: "SUCCESS",
            orderId,
            executedAt: new Date(),
            errorMessage: undefined,
            ipAddress: networkMeta.usedIpLabel,
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
              ipAddress: networkMeta.usedIpLabel,
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
            usedIp: networkMeta.usedIp,
            networkRoute: networkMeta.routeType,
            brokerError: {
              error: message,
              stack: error?.stack,
              usedIp: networkMeta.usedIpLabel,
              networkRoute: networkMeta.routeType,
              agentUrl: networkMeta.agentUrl,
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
