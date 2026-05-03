// src/services/SignalBroadcastService.ts
import mongoose from "mongoose";
import User from "../models/User";
import { Signal } from "../models/Signal";
import { SignalExecutionResult } from "../models/SignalExecutionResult";
import { TradeOutbox } from "../models/TradeOutbox";
import log from "../utils/logger";
import { v4 as uuidv4 } from "uuid";
import { decrypt } from "../utils/encryption";

export class SignalBroadcastService {
    static async broadcast(signalId: string, correlationId: string = uuidv4()) {
        const logger = log.child({ correlationId, signalId });
        
        // 🛡️ Check if MongoDB is running as a Replica Set (required for Transactions)
        const mongoClient = mongoose.connection.getClient() as any;
        const topoType = String(mongoClient?.topology?.description?.type || mongoClient?.topology?.type || "");
        const topoName = String(mongoClient?.topology?.constructor?.name || "");
        const isReplicaSet = topoType.includes("ReplicaSet") || topoName.includes("ReplicaSet");

        if (!isReplicaSet) {
            log.warn("[DB] Standalone MongoDB detected. Running broadcast WITHOUT transaction.");
            return await this.executeBroadcast(signalId, correlationId, undefined, logger);
        }

        const session = await mongoose.startSession();
        try {
            let result;
            await session.withTransaction(async () => {
                result = await this.executeBroadcast(signalId, correlationId, session, logger);
            });
            logger.info("Broadcast Outbox records created successfully");
            return result;
        } catch (err: any) {
            log.error("[SignalBroadcastService] Transaction failed:", err.message);
            throw err;
        } finally {
            session.endSession();
        }
    }

    private static async executeBroadcast(signalId: string, correlationId: string, session: any, logger: any) {
        const signal = await Signal.findById(signalId).session(session);
        if (!signal) throw new Error("Signal not found");

        // 🚀 Fetch users matching the signal strategy (Case-Insensitive)
        const targetStrategy = signal.strategy || "Manual";
        
        // Build a flexible regex for strategy matching
        const strategyRegex = new RegExp(`^${targetStrategy}$`, "i");

        const strategyQuery = targetStrategy === "Manual"
            ? { $or: [{ strategies: "Manual" }, { strategies: { $size: 0 } }, { strategies: { $exists: false } }] }
            : { strategies: { $in: [strategyRegex, targetStrategy] } };

        const users = await User.find({ 
            status: "active", 
            trading_status: "enabled",
            ...strategyQuery
        }).session(session).lean();

        if (users.length === 0) {
            log.warn(`[SignalBroadcastService] No active users found matching strategy: ${targetStrategy}`);
            signal.status = "EXECUTION_IN_PROGRESS";
            signal.totalExecutions = 0;
            await signal.save({ session });
            return { totalUsers: 0, livePlaced: 0, demoPlaced: 0, executions: [] };
        }

        // Update signal status and target count
        signal.status = "EXECUTION_IN_PROGRESS";
        signal.totalExecutions = users.length;
        await signal.save({ session });

        const executions: any[] = [];
        let liveCount = 0;
        let demoCount = 0;

        for (const user of users) {
            // 🛡️ UNIQUE ID: SignalID + UserID + Timestamp (prevents collision)
            const ts = Date.now().toString().slice(-4);
            const clientOrderId = `SIG-${signalId.toString().slice(-4)}-${user._id.toString().slice(-4)}-${ts}`;
            
            const userLicence = String(user.licence || "Live").toLowerCase();
            const isLive = userLicence === "live";

            try {
                // 🛡️ 2. RECORD EXECUTION INTENT
                await SignalExecutionResult.create([{
                    signalId,
                    userId: user._id,
                    clientOrderId,
                    broker: user.broker || "ANGELONE",
                    status: "PENDING",
                    correlationId,
                }], { session });

                // 🛡️ 3. WRITE TO OUTBOX
                await TradeOutbox.create([{
                    correlationId,
                    payload: {
                        userId: user._id,
                        signalId,
                        clientOrderId,
                        clientCode: user.client_key ? decrypt(user.client_key) : "",
                        orderData: {
                            exchange: signal.exchange || "NFO",
                            tradingsymbol: signal.tradingsymbol,
                            symboltoken: signal.symboltoken,
                            side: signal.side,
                            quantity: signal.quantity,
                            ordertype: "MARKET",
                            strategy: targetStrategy,
                            clientOrderId
                        }
                    }
                }], { session });

                if (isLive) liveCount++; else demoCount++;

                executions.push({
                    userName: user.user_name || user.email,
                    licence: user.licence || "Live",
                    online: user.is_online || false,
                    broker: user.broker || "ANGELONE",
                    status: "QUEUED",
                    message: "Order queued"
                });
                
            } catch (err: any) {
                executions.push({
                    userName: user.user_name || user.email,
                    licence: user.licence || "Live",
                    online: user.is_online || false,
                    broker: user.broker || "ANGELONE",
                    status: "FAILED",
                    message: err.message
                });
            }
        }
        
        return { 
            totalUsers: users.length, 
            livePlaced: liveCount,
            demoPlaced: demoCount,
            executions 
        };
    }
}
