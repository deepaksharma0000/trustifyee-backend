// src/utils/tradeQueue.ts
import { Queue } from "bullmq";
import { redisConnection } from "./redis";

/**
 * STRICT JOB SCHEMA
 */
export type TradeJob = {
  userId: string;
  signalId: string;
  clientCode: string;
  orderData: {
    exchange: string;
    tradingsymbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    strategy: string;
    symboltoken?: string;
    orderType: "MARKET" | "LIMIT";
  };
  correlationId: string;
  timestamp: number;
};

export const tradeQueue = new Queue("trade-execution", {
    connection: redisConnection as any,
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
    connection: redisConnection as any,
});

export default tradeQueue;
