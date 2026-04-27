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
            log.info(`[ExecutionAgent] Executing signal ${job.data.signalId} for user ${userId}`);

            try {
                // The OrderService will use user.outgoing_ip (staticIp) for binding
                const resp = await placeOrderForClient(userId, job.data.clientCode, {
                    ...job.data.orderData,
                    outgoingIp: staticIp // Force binding to the assigned static IP
                });

                await SignalExecutionResult.create({
                    signalId: job.data.signalId,
                    userId,
                    broker: "ANGELONE",
                    status: "SUCCESS",
                    orderId: resp?.data?.orderid || "SIG-NODE-001",
                    ipAddress: staticIp,
                    nodeId: process.env.HOSTNAME // Docker container ID
                });

            } catch (err: any) {
                log.error(`[ExecutionAgent] Order Failed: ${err.message}`);
                throw err;
            }
        },
        { 
            connection,
            concurrency: 1 // Strict isolation: process one order at a time per user node
        }
    );

    worker.on("failed", (job, err) => {
        log.error(`[ExecutionAgent] Job ${job?.id} failed:`, err);
    });
}

startAgent().catch(console.error);
