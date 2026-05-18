// src/utils/tradeQueue.ts
import { Queue } from "bullmq";
import { redisBullConnection } from "./redis";

/**
 * STRICT JOB SCHEMA
 */
export type TradeJob = {
  userId: string;
  signalId: string;
  clientCode: string;
  clientOrderId: string;
  correlationId: string;
  outgoingIp?: string;
  agentUrl?: string;
  dedicatedIpEnabled?: boolean;
  orderData: {
    exchange: string;
    tradingsymbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    strategy: string;
    symboltoken?: string;
    orderType: "MARKET" | "LIMIT";
  };
  timestamp: number;
};

export const TRADE_QUEUE_DEFAULT = "trade-execution";
export const TRADE_QUEUE_BY_BROKER: Record<string, string> = {
  ANGELONE: "trade-execution-angelone",
  ALICEBLUE: "trade-execution-aliceblue",
  UPSTOX: "trade-execution-upstox",
};

const queueCache = new Map<string, Queue>();

export let currentStartupCorrelationId: string = "unknown";
export function setStartupCorrelationId(id: string) {
  currentStartupCorrelationId = id;
  log.info(`[BullMQ] Configured Startup Correlation ID: ${id}`);
}

function createTradeQueue(name: string) {
  return new Queue(name, {
    connection: redisBullConnection as any,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 2000,
      },
      removeOnComplete: true,
      removeOnFail: false, // Keep for audit/debugging
    },
  });
}

export function resolveTradeQueueName(broker?: string) {
  const key = String(broker || "").trim().toUpperCase();
  return TRADE_QUEUE_BY_BROKER[key] || TRADE_QUEUE_DEFAULT;
}

export function getTradeQueueByName(name: string) {
  if (!queueCache.has(name)) {
    queueCache.set(name, createTradeQueue(name));
  }
  return queueCache.get(name)!;
}

export function getTradeQueueForBroker(broker?: string) {
  return getTradeQueueByName(resolveTradeQueueName(broker));
}

export const tradeQueue = getTradeQueueByName(TRADE_QUEUE_DEFAULT);

export function getAllTradeQueueNames() {
  return [TRADE_QUEUE_DEFAULT, ...Object.values(TRADE_QUEUE_BY_BROKER)];
}

export async function getTotalTradeQueueWaitingCount() {
  const names = getAllTradeQueueNames();
  const counts = await Promise.all(names.map((name) => getTradeQueueByName(name).getWaitingCount().catch(() => 0)));
  return counts.reduce((sum, n) => sum + (Number(n) || 0), 0);
}

export async function getTotalTradeQueueFailedCount() {
  const names = getAllTradeQueueNames();
  const counts = await Promise.all(names.map((name) => getTradeQueueByName(name).getFailedCount().catch(() => 0)));
  return counts.reduce((sum, n) => sum + (Number(n) || 0), 0);
}

// Keep default queue export for backward compatibility.
getTradeQueueByName(TRADE_QUEUE_DEFAULT);

Object.values(TRADE_QUEUE_BY_BROKER).forEach((name) => {
  getTradeQueueByName(name);
});

/**
 * REPEATABLE RISK CHECK QUEUE
 */
export const riskQueue = new Queue("risk-management", {
    connection: redisBullConnection as any,
});

export async function shutdownTradeQueues() {
  log.info("[TradeQueue] Shutting down queues...");
  const queuesToClose = Array.from(queueCache.values());
  if (riskQueue) {
    queuesToClose.push(riskQueue);
  }
  await Promise.all(
    queuesToClose.map((q) =>
      q.close().catch((err) => log.error("[TradeQueue] Error closing queue:", err))
    )
  );
  queueCache.clear();
  log.info("[TradeQueue] All queues closed cleanly.");
}

// Simple helper logger import just in case
import log from "./logger";

export default tradeQueue;
