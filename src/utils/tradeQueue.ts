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

export const tradeQueue = new Queue("trade-execution", {
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

/**
 * REPEATABLE RISK CHECK QUEUE
 */
export const riskQueue = new Queue("risk-management", {
    connection: redisBullConnection as any,
});

export default tradeQueue;
