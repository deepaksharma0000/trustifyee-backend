// src/services/SignalBroadcastService.ts
import mongoose from "mongoose";
import User from "../models/User";
import { Signal } from "../models/Signal";
import { SignalExecutionResult } from "../models/SignalExecutionResult";
import { TradeOutbox } from "../models/TradeOutbox";
import log from "../utils/logger";
import { decrypt } from "../utils/encryption";
import { v4 as uuidv4 } from 'uuid';

export class SignalBroadcastService {
    
    // 🛡️ CRITICAL FIX 2: Restore broadcast() entry point
    static async broadcast(signalId: string) {
        const signal = await Signal.findById(signalId).lean();
        if (!signal) throw new Error("Signal not found");
        return await this.executeBroadcast(signal);
    }

    // 🛡️ CRITICAL FIX 3: Replica Set warning and Transaction Guard
    static async executeBroadcast(signal: any) {
        const mongoClient = mongoose.connection.getClient() as any;
        const topoType = String(mongoClient?.topology?.description?.type || mongoClient?.topology?.type || "");
        const topoName = String(mongoClient?.topology?.constructor?.name || "");
        const isReplicaSet = topoType.includes("ReplicaSet") || topoName.includes("ReplicaSet");

        if (!isReplicaSet) {
            log.warn("[DB] Standalone MongoDB — running without transaction.");
            return await this._runBroadcast(signal, undefined);
        }

        const session = await mongoose.startSession();
        try {
            let result: any;
            await session.withTransaction(async () => {
                result = await this._runBroadcast(signal, session);
            });
            return result;
        } catch (err: any) {
            log.error("[SignalBroadcastService] Broadcast transaction failed:", err.message);
            throw err;
        } finally {
            session.endSession();
        }
    }

    private static async _runBroadcast(signal: any, session: any) {
        const signalId = signal._id || (signal as any).signalId;
        const targetStrategy = signal.strategy || "Manual";
        const correlationId = uuidv4();

        // 🚀 Fetch users matching the signal strategy
        const strategyRegex = new RegExp(`^${targetStrategy}$`, "i");
        const strategyQuery = targetStrategy === "Manual"
            ? { $or: [{ strategies: "Manual" }, { strategies: { $size: 0 } }, { strategies: { $exists: false } }] }
            : { strategies: { $in: [strategyRegex, targetStrategy] } };

        const users = await User.find({ 
            status: "active", 
            trading_status: "enabled",
            ...strategyQuery
        }).select('user_name email client_key licence broker outgoing_ip').session(session).lean();

        if (users.length === 0) {
            log.warn(`[SignalBroadcastService] No users for strategy: ${targetStrategy}`);
            await Signal.updateOne({ _id: signalId }, { 
                status: "EXECUTION_IN_PROGRESS", 
                totalExecutions: 0 
            }, { session });
            return { totalUsers: 0, livePlaced: 0, demoPlaced: 0, executions: [] };
        }

        // Update signal status
        await Signal.updateOne({ _id: signalId }, { 
            status: "EXECUTION_IN_PROGRESS", 
            totalExecutions: users.length 
        }, { session });

        const executions: any[] = [];
        let liveCount = 0;
        let demoCount = 0;

        for (const user of users) {
            const ts = Date.now().toString().slice(-4);
            const clientOrderId = `AUTO-${signalId.toString().slice(-4)}-${user._id.toString().slice(-4)}-${ts}`;
            
            const userLicence = String(user.licence || "Live").toLowerCase();
            const isLive = userLicence === "live";

            try {
                // 🛡️ CRITICAL FIX 2: RECORD EXECUTION INTENT (Inside loop)
                await SignalExecutionResult.create([{
                    signalId,
                    userId: user._id,
                    clientOrderId,
                    broker: user.broker || "ANGELONE",
                    status: "PENDING",
                    correlationId,
                }], { session });

                // 🛡️ SEBI COMPLIANCE: Static IP Guard
                const outgoingIp = user.outgoing_ip;
                if (!outgoingIp || String(outgoingIp).trim() === "") {
                    const ipError = "User static IP not registered. Please contact admin.";
                    log.error(`[SEBI_VIOLATION] ${user.user_name || user.email} - IP missing. Blocking broadcast.`);
                    
                    await SignalExecutionResult.create([{
                        signalId,
                        userId: user._id,
                        clientOrderId,
                        broker: user.broker || "ANGELONE",
                        status: "FAILED",
                        message: ipError,
                        correlationId,
                    }], { session });

                    executions.push({
                        userName: user.user_name || user.email,
                        status: "FAILED",
                        message: ipError
                    });
                    continue;
                }

                // 🛡️ WRITE TO OUTBOX
                await TradeOutbox.create([{
                    correlationId,
                    payload: {
                        userId: user._id,
                        signalId,
                        clientOrderId,
                        clientCode: user.client_key ? decrypt(user.client_key) : "",
                        outgoingIp: outgoingIp,
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
                    status: "QUEUED"
                });
                
            } catch (err: any) {
                executions.push({
                    userName: user.user_name || user.email,
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
