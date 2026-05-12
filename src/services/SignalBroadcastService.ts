import mongoose from "mongoose";
import User from "../models/User";
import { Signal } from "../models/Signal";
import { SignalExecutionResult } from "../models/SignalExecutionResult";
import { TradeOutbox } from "../models/TradeOutbox";
import log from "../utils/logger";
import { decrypt } from "../utils/encryption";
import { v4 as uuidv4 } from "uuid";

const BATCH_SIZE = 50;

export class SignalBroadcastService {
  static async broadcast(signalId: string) {
    const signal = await Signal.findById(signalId).lean();
    if (!signal) throw new Error("Signal not found");
    return this.executeBroadcast(signal);
  }

  static async executeBroadcast(signal: any) {
    const mongoClient = mongoose.connection.getClient() as any;
    const topoType = String(
      mongoClient?.topology?.description?.type || mongoClient?.topology?.type || ""
    );
    const topoName = String(mongoClient?.topology?.constructor?.name || "");
    const isReplicaSet = topoType.includes("ReplicaSet") || topoName.includes("ReplicaSet");

    if (!isReplicaSet) {
      log.warn("[SignalBroadcastService] Standalone MongoDB detected. Running without transaction.");
      return this._runBroadcast(signal, undefined);
    }

    const session = await mongoose.startSession();
    try {
      let result: any;
      await session.withTransaction(async () => {
        result = await this._runBroadcast(signal, session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  private static buildStrategyQuery(targetStrategy: string) {
    const strategyRegex = new RegExp(`^${targetStrategy}$`, "i");

    if (targetStrategy === "Manual") {
      return {
        $or: [
          { strategies: "Manual" },
          { strategies: { $size: 0 } },
          { strategies: { $exists: false } },
        ],
      };
    }

    return {
      strategies: { $in: [strategyRegex, targetStrategy] },
    };
  }

  private static async _runBroadcast(signal: any, session?: mongoose.ClientSession) {
    const signalId = signal._id || (signal as any).signalId;
    const targetStrategy = signal.strategy || "Manual";
    const batchCorrelationId = uuidv4();
    const startedAt = Date.now();

    const strategyQuery = this.buildStrategyQuery(targetStrategy);
    const usersQuery = User.find({
      status: "active",
      trading_status: "enabled",
      broker_connected: true,
      ...strategyQuery,
    })
      .select("user_name email client_key licence broker outgoing_ip agent_url")
      .lean();

    if (session) usersQuery.session(session);
    const users = await usersQuery;

    if (users.length === 0) {
      await Signal.updateOne(
        { _id: signalId },
        {
          status: "FAILED",
          totalExecutions: 0,
        },
        session ? { session } : undefined
      );

      return {
        totalUsers: 0,
        queued: 0,
        failed: 0,
        livePlaced: 0,
        demoPlaced: 0,
        executions: [],
      };
    }

    await Signal.updateOne(
      { _id: signalId },
      {
        status: "EXECUTION_IN_PROGRESS",
        totalExecutions: users.length,
      },
      session ? { session } : undefined
    );

    const executions: any[] = [];
    let liveCount = 0;
    let demoCount = 0;
    let queuedCount = 0;
    let failedCount = 0;

    const processUser = async (user: any, index: number) => {
      const clientOrderId = `AUTO-${String(signalId).slice(-4)}-${String(user._id).slice(-4)}-${Date.now()
        .toString()
        .slice(-4)}-${index}`;
      const correlationId = `${batchCorrelationId}:${index}`;
      const userName = user.user_name || user.email || String(user._id);

      const userLicence = String(user.licence || "Live").toLowerCase();
      const isLive = userLicence === "live";

      const rawClientCode = user.client_key ? decrypt(user.client_key) : "";
      if (!rawClientCode || rawClientCode.trim().length < 3) {
        failedCount += 1;
        await SignalExecutionResult.findOneAndUpdate(
          { signalId, userId: user._id },
          {
            signalId,
            userId: user._id,
            clientOrderId,
            broker: user.broker || "ANGELONE",
            status: "FAILED",
            errorMessage: "Client code missing or invalid",
            correlationId,
          },
          {
            upsert: true,
            new: true,
            session,
            setDefaultsOnInsert: true,
          }
        );

        executions.push({ userName, licence: user.licence || "Live", status: "FAILED", message: "Client code missing or invalid" });
        return;
      }

      await SignalExecutionResult.findOneAndUpdate(
        { signalId, userId: user._id },
        {
          signalId,
          userId: user._id,
          clientOrderId,
          broker: user.broker || "ANGELONE",
          status: "PENDING",
          errorMessage: undefined,
          correlationId,
          source: "SERVER_QUEUE",
        },
        {
          upsert: true,
          new: true,
          session,
          setDefaultsOnInsert: true,
        }
      );

      await TradeOutbox.create(
        [
          {
            correlationId,
            payload: {
              userId: String(user._id),
              signalId: String(signalId),
              clientOrderId,
              clientCode: rawClientCode,
              outgoingIp: user.outgoing_ip || undefined,
              agentUrl: user.agent_url || undefined,
              orderData: {
                exchange: signal.exchange || "NFO",
                tradingsymbol: signal.tradingsymbol,
                symboltoken: signal.symboltoken,
                side: signal.side,
                quantity: signal.quantity,
                ordertype: "MARKET",
                strategy: targetStrategy,
                broker: user.broker || "ANGELONE",
              },
            },
          },
        ],
        session ? { session } : undefined
      );

      queuedCount += 1;
      if (isLive) liveCount += 1;
      else demoCount += 1;

      executions.push({
        userName,
        licence: user.licence || "Live",
        status: "QUEUED",
        correlationId,
      });
    };

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);

      const settled = await Promise.allSettled(
        batch.map((user, batchIndex) => processUser(user, i + batchIndex))
      );

      settled.forEach((item, settledIndex) => {
        if (item.status === "fulfilled") return;
        const user = batch[settledIndex];
        const userName = user?.user_name || user?.email || String(user?._id || "UNKNOWN");
        const reason = item.reason?.message || "Broadcast queueing failed";

        failedCount += 1;
        executions.push({ userName, licence: user?.licence || "Live", status: "FAILED", message: reason });

        SignalExecutionResult.findOneAndUpdate(
          { signalId, userId: user?._id },
          {
            $set: {
              status: "FAILED",
              errorMessage: reason,
              executedAt: new Date(),
            },
            $setOnInsert: {
              signalId,
              userId: user?._id,
              broker: user?.broker || "ANGELONE",
              source: "SERVER_QUEUE",
            },
          },
          { upsert: true, session }
        ).catch(() => undefined);

        log.error("[SignalBroadcastService] Failed to queue user execution", {
          signalId: String(signalId),
          userId: String(user?._id || ""),
          message: reason,
        });
      });
    }

    log.info("[SignalBroadcastService] Broadcast fan-out completed", {
      signalId: String(signalId),
      users: users.length,
      queued: queuedCount,
      failed: failedCount,
      durationMs: Date.now() - startedAt,
    });

    if (queuedCount === 0) {
      await Signal.updateOne(
        { _id: signalId },
        { status: "FAILED" },
        session ? { session } : undefined
      );
    }

    return {
      totalUsers: users.length,
      queued: queuedCount,
      failed: failedCount,
      livePlaced: liveCount,
      demoPlaced: demoCount,
      executions,
    };
  }
}
