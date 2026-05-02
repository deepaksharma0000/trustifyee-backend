import { Worker } from "bullmq";
import { placeOrderForClient } from "../services/OrderService";
import { SignalExecutionResult } from "../models/SignalExecutionResult";
import User from "../models/User";
import log from "../utils/logger";
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

/**
 * ISOLATED EXECUTION AGENT
 * 
 * This process runs inside a dedicated Docker container for a SINGLE USER.
 * It binds all outgoing traffic to a UNIQUE STATIC IP.
 */

const userId = process.env.USER_ID!;
const staticIp = process.env.USER_STATIC_IP!; // The unique IPv4 for this container
const redisHost = process.env.REDIS_HOST || "127.0.0.1";
const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017/angelone";

if (!userId || !staticIp) {
    console.error("FATAL: USER_ID and USER_STATIC_IP environment variables are required.");
    process.exit(1);
}

const connection = { host: redisHost, port: 6379 };

async function startAgent() {
    await mongoose.connect(mongoUri);
    log.info(`[ExecutionAgent] Started for User: ${userId} | IP: ${staticIp}`);

    const worker = new Worker(
        `trade-execution:${userId}`, // Dedicated queue per user
        async (job) => {
            const { signalId, clientCode, orderData } = job.data;
            log.info(`[ExecutionAgent] Executing signal ${signalId} | Symbol: ${orderData.tradingsymbol} | Token: ${orderData.symboltoken}`);

            try {
                // 🛡️ Pre-Execution Status Update
                await SignalExecutionResult.findOneAndUpdate(
                    { signalId, userId },
                    { status: "QUEUED", executedAt: new Date() },
                    { upsert: true }
                );

                // Place order with forced IP binding
                const resp = await placeOrderForClient(userId, clientCode, {
                    ...orderData,
                    outgoingIp: staticIp 
                });

                const orderId = resp?.data?.orderid || resp?.data?.data?.orderid || "SIG-NODE-001";

                // ✅ SUCCESS Update
                await SignalExecutionResult.findOneAndUpdate(
                    { signalId, userId },
                    { 
                        status: "SUCCESS", 
                        orderId, 
                        ipAddress: staticIp,
                        brokerResponse: resp?.data,
                        executedAt: new Date()
                    }
                );

                log.info(`[ExecutionAgent] SUCCESS: Order ${orderId} placed for user ${userId}`);

            } catch (err: any) {
                log.error(`[ExecutionAgent] Order Failed: ${err.message}`);

                // ❌ FAILURE Update
                await SignalExecutionResult.findOneAndUpdate(
                    { signalId, userId },
                    { 
                        status: "FAILED", 
                        errorMessage: err.message,
                        ipAddress: staticIp,
                        executedAt: new Date()
                    }
                );

                throw err; // Trigger BullMQ retry
            }
        },
        { 
            connection,
            concurrency: 1 
        }
    );


    worker.on("failed", (job, err) => {
        log.error(`[ExecutionAgent] Job ${job?.id} failed:`, err);
    });
}

startAgent().catch(console.error);
