import { Worker } from "bullmq";
import { redisBullConnection } from "../utils/redis";
import { fetchBrokerOrder } from "../services/OrderService";
import { TradeExecutionService } from "../services/TradeExecutionService";
import { SignalExecutionResult } from "../models/SignalExecutionResult";
import { CircuitBreakerService } from "../services/CircuitBreakerService";
import { AlertService } from "../services/AlertService";
import User from "../models/User";
import log from "../utils/logger";
import { getAllTradeQueueNames } from "../utils/tradeQueue";
import { config } from "../config";
import { parseAngelOrderPlacement } from "../utils/angelResponseParser";
import { broadcastToUser } from "../services/UserSocketService";

const notifyUserExecution = (
  userId: string,
  payload: {
    signalId?: string;
    clientOrderId?: string;
    orderId?: string;
    status: "SUCCESS" | "FAILED" | "PENDING" | "QUEUED";
    tradingsymbol?: string;
    side?: string;
    message?: string;
    source?: string;
  }
) => {
  const delivered = broadcastToUser(String(userId), {
    type: "TRADE_EXECUTION_UPDATE",
    data: {
      ...payload,
      updatedAt: new Date().toISOString(),
    },
  });
  log.info("[USER_EXECUTION_NOTIFY]", {
    userId,
    status: payload.status,
    tradingsymbol: payload.tradingsymbol,
    delivered,
  });
};

const toSafeMessage = (error: unknown) => {
  if (!error) return "Unknown execution failure";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
};

const isNoRetryRejection = (message: string) => {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("api key mismatch against app found with static ip in request") ||
    m.includes("unregistered ip") ||
    m.includes("register your ip before retrying") ||
    m.includes("api_key_route_not_verified") ||
    m.includes("api_key_route_mismatch") ||
    m.includes("ag8004") ||
    m.includes("invalid api key") ||
    m.includes("broker_api_key_token_mismatch") ||
    m.includes("broker_session_client_mismatch") ||
    m.includes("live_execution_required") ||
    m.includes("live_execution_blocked_whitelist_mismatch") ||
    m.includes("margin") ||
    m.includes("insufficient") ||
    m.includes("broker rejected") ||
    m.includes("invalid order") ||
    m.includes("invalid product")
  );
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
  const dedicatedRoutingEnabled = dedicatedIpEnabled === true;

  if (config.forceSharedVpsRoute && !dedicatedRoutingEnabled) {
    return {
      usedIp: normalizedPublicIp || null,
      usedIpLabel: normalizedPublicIp || "UNKNOWN",
      routeType: "SERVER_SHARED_IP",
      agentUrl: null,
    };
  }

  if (!dedicatedRoutingEnabled) {
    return {
      usedIp: normalizedPublicIp || null,
      usedIpLabel: normalizedPublicIp || "UNKNOWN",
      routeType: normalizedPublicIp ? "SERVER_SHARED_IP" : "UNKNOWN",
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

const normalizeBrokerOrderStatus = (payload: any): string => {
  const raw = payload?.orderstatus || payload?.status || payload?.orderStatus || payload?.order_state || "";
  return String(raw || "").trim().toUpperCase();
};

const isAcceptedOrderState = (status: string) => {
  const s = String(status || "").toUpperCase();
  return s === "OPEN" || s === "COMPLETE" || s === "TRIGGER PENDING" || s === "PARTIALLY FILLED";
};

const activeWorkers: Worker[] = [];

export const initTradeExecutionWorker = () => {
  if (activeWorkers.length > 0) {
    log.warn("[TradeExecutionWorker] Workers already initialized.");
    return;
  }

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

        const requestedOutgoingIp =
          jobOutgoingIp && String(jobOutgoingIp).trim() !== ""
            ? String(jobOutgoingIp).trim()
            : userDoc.outgoing_ip || undefined;

        const requestedAgentUrl =
          jobAgentUrl && String(jobAgentUrl).trim() !== ""
            ? String(jobAgentUrl).trim()
            : (userDoc as any).agent_url || undefined;
        const dedicatedIpEnabled =
          Boolean(jobDedicatedIpEnabled) || Boolean((userDoc as any)?.dedicated_ip_enabled === true);
        const userLicence = String((userDoc as any)?.licence || "Live").toLowerCase();
        const requireLiveExecution = userLicence === "live";

        if (!dedicatedIpEnabled && (requestedOutgoingIp || requestedAgentUrl)) {
          logger.warn("[ORDER_ROUTE_HINT_IGNORED]", {
            reason: "dedicated_ip_enabled=false",
            hasOutgoingIp: Boolean(requestedOutgoingIp),
            hasAgentUrl: Boolean(requestedAgentUrl),
          });
        }

        const outgoingIp = dedicatedIpEnabled ? requestedOutgoingIp : undefined;
        const agentUrl = dedicatedIpEnabled ? requestedAgentUrl : undefined;

        networkMeta = resolveNetworkMeta(outgoingIp, agentUrl, dedicatedIpEnabled);
        logger.info("[ORDER_ROUTE_RESOLVED]", {
          routeType: networkMeta.routeType,
          usedIp: networkMeta.usedIpLabel,
          hasAgent: Boolean(agentUrl),
          dedicatedIpEnabled,
        });

        logger.info("BROKER_EXECUTION_CONTEXT", {
          userId,
          clientCode,
          broker,
          purpose: "trade_queue_worker",
          apiKeyLast4: "N/A",
          requestIp: networkMeta.usedIpLabel,
          routeType: networkMeta.routeType,
          tokenOwner: userId,
          executionMode: config.executionMode,
          correlationId,
          clientOrderId,
        });

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
            outgoingIp,
            orderData?.tradingsymbol
          );
          const existingStatus = normalizeBrokerOrderStatus(existingOrder);
          if (existingOrder && isAcceptedOrderState(existingStatus)) {
            logger.warn("Broker already has order for this clientOrderId. Synchronizing instead of placing duplicate order.");
            await SignalExecutionResult.updateOne(
              { clientOrderId },
              {
                $set: {
                  status: "SUCCESS",
                  orderId: existingOrder.orderid,
                  executedAt: new Date(),
                  errorMessage: undefined,
                  ipAddress: networkMeta.usedIpLabel,
                  brokerOrderStatus: existingStatus || "OPEN",
                  brokerResponse: existingOrder,
                },
              }
            );
            return;
          }
        } catch (checkErr) {
          logger.debug("Broker idempotency check could not confirm an existing order. Continuing fresh placement.", checkErr);
        }

        const resp = await TradeExecutionService.executeUserOrder({
          userId,
          clientCode,
          signalId,
          clientOrderId,
          correlationId,
          outgoingIp,
          agentUrl,
          dedicatedIpEnabled,
          orderData: {
            ...orderData,
            requireLiveExecution,
          },
        });

        const responseData = resp?.data || {};
        const parsedOrder = parseAngelOrderPlacement(resp);
        const responsePayload =
          responseData?.data && typeof responseData.data === "object" ? responseData.data : responseData;
        const orderId = parsedOrder.brokerOrderId || parsedOrder.uniqueOrderId || (parsedOrder.accepted ? clientOrderId : undefined);
        const brokerOrderStatus = normalizeBrokerOrderStatus(responsePayload);
        const brokerMessage = String(
          parsedOrder.rejectionReason ||
            parsedOrder.brokerMessage ||
            responseData?.message ||
            resp?.message ||
            ""
        );
        const loweredMessage = brokerMessage.toLowerCase();
        const isRejectedMessage =
          loweredMessage.includes("reject") ||
          loweredMessage.includes("failed") ||
          loweredMessage.includes("error") ||
          loweredMessage.includes("invalid");
        const isSimulated =
          Boolean(responseData?.simulated || resp?.simulated) ||
          String(responseData?.executionMode || "").toLowerCase() === "paper" ||
          String(orderId || "").toUpperCase().startsWith("PAPER-");
        const treatSimulatedAsSuccess = isSimulated && !requireLiveExecution;
        const isBrokerSubmissionSuccess =
          parsedOrder.accepted &&
          (resp?.status === 200 || resp?.ok === true || resp?.status === true) &&
          !isRejectedMessage &&
          !isSimulated;

        const isRealSuccess = isBrokerSubmissionSuccess || treatSimulatedAsSuccess;

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
          message: isBrokerSubmissionSuccess
            ? "Order accepted by broker and pending status sync"
            : treatSimulatedAsSuccess
            ? "Order executed in paper mode"
            : rejectedMessage,
          usedIp: networkMeta.usedIp,
          networkRoute: networkMeta.routeType,
          brokerError: isRealSuccess
            ? undefined
            : {
                ...(responseData || resp || {}),
                usedIp: networkMeta.usedIpLabel,
                networkRoute: networkMeta.routeType,
                agentUrl: networkMeta.agentUrl,
            },
        });

        if (!isRealSuccess) {
          if (isNoRetryRejection(rejectedMessage)) {
            logger.warn("[ORDER_NO_RETRY] Permanent rejection detected. Skipping queue retries.", {
              reason: rejectedMessage,
            });
            await SignalExecutionResult.updateOne(
              { clientOrderId },
              {
                $set: {
                  status: "FAILED",
                  errorMessage: rejectedMessage,
                  brokerRejectReason: rejectedMessage,
                  brokerOrderStatus: parsedOrder.errorCode || "BROKER_REJECTED",
                  brokerResponse: parsedOrder.rawResponse || responseData,
                  executedAt: new Date(),
                  correlationId,
                  ipAddress: networkMeta.usedIpLabel,
                },
              }
            ).catch(() => undefined);
            await CircuitBreakerService.recordFailure(broker, "ORDER").catch(() => undefined);
            notifyUserExecution(userId, {
              signalId,
              clientOrderId,
              orderId: orderId || undefined,
              status: "FAILED",
              tradingsymbol: orderData?.tradingsymbol,
              side: orderData?.side,
              message: rejectedMessage,
              source: "ADMIN_SERVER_EXECUTION",
            });
            return;
          }
          throw new Error(rejectedMessage);
        }

        await SignalExecutionResult.updateOne(
          { clientOrderId },
          {
            $set: {
              status: isBrokerSubmissionSuccess ? "PENDING" : "SUCCESS",
              orderId,
              executedAt: new Date(),
              errorMessage: undefined,
              brokerRejectReason: undefined,
              ipAddress: networkMeta.usedIpLabel,
              brokerOrderStatus: isBrokerSubmissionSuccess
                ? brokerOrderStatus || "PENDING_BROKER"
                : "PAPER",
              brokerResponse: responseData,
              lastSyncedAt: new Date(),
            },
          }
        );

        await CircuitBreakerService.recordSuccess(broker, "ORDER");
        logger.info("Trade execution accepted", {
          orderId,
          status: isBrokerSubmissionSuccess ? "PENDING_BROKER_SYNC" : "SIMULATED_SUCCESS",
        });
        notifyUserExecution(userId, {
          signalId,
          clientOrderId,
          orderId: orderId || undefined,
          status: isBrokerSubmissionSuccess ? "PENDING" : "SUCCESS",
          tradingsymbol: orderData?.tradingsymbol,
          side: orderData?.side,
          message: isBrokerSubmissionSuccess
            ? `Order placed on Angel One — Order ID ${orderId}`
            : "Order executed in paper/demo mode",
          source: "ADMIN_SERVER_EXECUTION",
        });
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
              brokerRejectReason: message,
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

        notifyUserExecution(userId, {
          signalId,
          clientOrderId,
          status: "FAILED",
          tradingsymbol: orderData?.tradingsymbol,
          side: orderData?.side,
          message,
          source: "ADMIN_SERVER_EXECUTION",
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

    activeWorkers.push(worker);
    log.info("[TradeExecutionWorker] Worker started", { queueName });
  };

  const queueNames = getAllTradeQueueNames();
  queueNames.forEach((queueName) => startWorkerForQueue(queueName));
};

export const shutdownTradeExecutionWorkers = async () => {
  log.info("[TradeExecutionWorker] Shutting down workers...");
  await Promise.all(
    activeWorkers.map((w) =>
      w.close().catch((err) => log.error("[TradeExecutionWorker] Error shutting down worker:", err))
    )
  );
  activeWorkers.length = 0;
  log.info("[TradeExecutionWorker] All trade execution workers shut down cleanly.");
};
