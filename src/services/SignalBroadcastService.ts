import mongoose from "mongoose";
import User from "../models/User";
import { Signal } from "../models/Signal";
import { SignalExecutionResult } from "../models/SignalExecutionResult";
import { TradeOutbox } from "../models/TradeOutbox";
import { BrokerResponse } from "../models/BrokerResponse";
import log from "../utils/logger";
import { decrypt } from "../utils/encryption";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config";
import { apiKeyFingerprint } from "../utils/apiKeyRouteBinding";

const BATCH_SIZE = 50;
const SUPPORTED_BROKERS = new Set(["ANGELONE", "ALICEBLUE", "UPSTOX"]);
const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;
const STATIC_IP_REJECTION_REGEX =
  /(api key mismatch against app found with static ip in request|unregistered ip|register your ip before retrying)/i;
const STATIC_REJECTION_HOLD_MS = Math.max(
  60 * 1000,
  Number(process.env.ORDER_STATIC_REJECTION_HOLD_MINUTES || "30") * 60 * 1000
);

function normalizeIpv4(value?: string) {
  const trimmed = String(value || "").trim();
  return IPV4_REGEX.test(trimmed) ? trimmed : "";
}

function resolveUserNetworkMeta(user: any) {
  const localBindingEnabled = process.env.ANGEL_ENABLE_LOCAL_BINDING === "true";
  const profileIp = normalizeIpv4(user?.outgoing_ip);
  const publicIp = normalizeIpv4(config.publicIp);
  const agentUrl = String(user?.agent_url || "").trim();
  const dedicatedIpEnabled = Boolean(user?.dedicated_ip_enabled === true);

  if (config.forceSharedVpsRoute && !dedicatedIpEnabled) {
    return {
      usedIp: publicIp || null,
      usedIpLabel: publicIp || "UNKNOWN",
      networkRoute: "SERVER_SHARED_IP",
    };
  }

  if (agentUrl) {
    return {
      usedIp: profileIp || null,
      usedIpLabel: profileIp || "AGENT_ROUTE",
      networkRoute: "AGENT_ROUTE",
    };
  }

  if (profileIp && !localBindingEnabled) {
    return {
      usedIp: publicIp || null,
      usedIpLabel: publicIp || "UNKNOWN",
      networkRoute: "SERVER_SHARED_IP",
    };
  }

  if (profileIp) {
    return {
      usedIp: profileIp,
      usedIpLabel: profileIp,
      networkRoute: "USER_STATIC_IP",
    };
  }

  if (publicIp) {
    return {
      usedIp: publicIp,
      usedIpLabel: publicIp,
      networkRoute: "SERVER_SHARED_IP",
    };
  }

  return {
    usedIp: null,
    usedIpLabel: "UNKNOWN",
    networkRoute: "UNKNOWN",
  };
}

function normalizeBroker(input: any): string {
  return String(input || "ANGELONE").trim().toUpperCase();
}

function shouldBlockForRecentStaticRejection(latestResponse: any, currentRouteIp?: string | null) {
  const latestMessage = String(latestResponse?.message || "");
  if (!STATIC_IP_REJECTION_REGEX.test(latestMessage)) return false;

  const latestUsedIp = normalizeIpv4(latestResponse?.usedIp);
  const currentUsedIp = normalizeIpv4(currentRouteIp || "");
  const routeChanged = Boolean(latestUsedIp && currentUsedIp && latestUsedIp !== currentUsedIp);

  if (routeChanged) return false;

  const latestAtMs = latestResponse?.createdAt
    ? new Date(latestResponse.createdAt).getTime()
    : Number.NaN;

  if (!Number.isFinite(latestAtMs)) return true;

  const ageMs = Date.now() - latestAtMs;
  return ageMs <= STATIC_REJECTION_HOLD_MS;
}

function checkUserEligibility(user: any, now: Date): { eligible: boolean; reason?: string } {
  if (!user) return { eligible: false, reason: "User not found" };

  const broker = normalizeBroker(user.broker);
  if (!SUPPORTED_BROKERS.has(broker)) {
    return { eligible: false, reason: `Broker not supported: ${broker || "UNKNOWN"}` };
  }

  const licence = String(user.licence || "Live").toLowerCase();
  const endDate = user.end_date ? new Date(user.end_date) : null;

  if (licence === "live" && endDate && !Number.isNaN(endDate.getTime()) && endDate.getTime() < now.getTime()) {
    return { eligible: false, reason: "Subscription expired" };
  }

  return { eligible: true };
}

export class SignalBroadcastService {
  private static async getLatestOrderResponseByUser(userIds: string[]) {
    if (!userIds.length) return new Map<string, any>();

    const rows = await BrokerResponse.aggregate([
      {
        $match: {
          userId: { $in: userIds },
          action: "PLACE_ORDER",
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$userId",
          message: { $first: "$message" },
          status: { $first: "$status" },
          usedIp: { $first: "$usedIp" },
          networkRoute: { $first: "$networkRoute" },
          createdAt: { $first: "$createdAt" },
        },
      },
    ]);

    const map = new Map<string, any>();
    for (const row of rows || []) {
      map.set(String(row?._id || ""), row);
    }
    return map;
  }

  private static buildReadinessEntry(user: any, latestResponse: any) {
    const userId = String(user?._id || "");
    const broker = normalizeBroker(user?.broker);
    const networkMeta = resolveUserNetworkMeta(user);
    const rawClientCode = user?.client_key ? decrypt(user.client_key) : "";
    const hasApiKey = Boolean(String(user?.api_key || "").trim());
    const latestMessage = String(latestResponse?.message || "");
    const latestUsedIp = String(latestResponse?.usedIp || "") || networkMeta.usedIpLabel;

    let ready = true;
    let reason = "READY";

    if (!rawClientCode || rawClientCode.trim().length < 3) {
      ready = false;
      reason = "Client code missing or invalid";
    } else if (broker === "ANGELONE" && !hasApiKey) {
      ready = false;
      reason = "Angel API key missing in user profile";
    } else if (broker === "ANGELONE" && shouldBlockForRecentStaticRejection(latestResponse, networkMeta.usedIp)) {
      ready = false;
      reason = latestMessage || "Static IP mapping rejected by broker for this user API key";
    }

    return {
      userId,
      userName: user?.user_name || null,
      email: user?.email || null,
      broker,
      licence: user?.licence || "Live",
      isOnlineDb: Boolean(user?.is_online || user?.is_login),
      ready,
      reason,
      clientCode: rawClientCode || null,
      apiKeyFingerprint: hasApiKey ? apiKeyFingerprint(decrypt(user.api_key || "")) : "EMPTY",
      routeType: networkMeta.networkRoute,
      usedIp: networkMeta.usedIpLabel,
      dedicatedIpEnabled: Boolean(user?.dedicated_ip_enabled === true),
      lastBrokerStatus: latestResponse?.status || null,
      lastBrokerMessage: latestMessage || null,
      lastBrokerUsedIp: latestUsedIp || null,
      lastBrokerAt: latestResponse?.createdAt || null,
      apiKeyIpPairVerified: Boolean(user?.api_key_ip_pair_verified === true),
      validatedRouteIp: user?.validated_route_ip || null,
      validatedRouteType: user?.validated_route_type || null,
    };
  }

  private static async buildReadinessMap(users: any[]) {
    const userIds = users.map((u) => String(u?._id || "")).filter(Boolean);
    const latestByUser = await this.getLatestOrderResponseByUser(userIds);
    const map = new Map<string, any>();

    for (const user of users) {
      const key = String(user?._id || "");
      map.set(key, this.buildReadinessEntry(user, latestByUser.get(key)));
    }

    return map;
  }

  static async getBroadcastReadinessReport(targetStrategy = "Manual") {
    const strategyQuery = this.buildStrategyQuery(targetStrategy);
    const users = await User.find({
      status: "active",
      trading_status: "enabled",
      broker_connected: true,
      ...strategyQuery,
    })
      .select(
        "user_name email client_key licence broker api_key outgoing_ip agent_url dedicated_ip_enabled api_key_ip_pair_verified validated_route_ip validated_route_type is_online is_login"
      )
      .lean();

    const readinessMap = await this.buildReadinessMap(users as any[]);
    const details = Array.from(readinessMap.values());
    const readyUsers = details.filter((d: any) => d.ready === true).length;
    const blockedUsers = details.length - readyUsers;

    return {
      strategy: targetStrategy,
      totalUsers: details.length,
      readyUsers,
      blockedUsers,
      details,
    };
  }

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
      .select(
        "user_name email client_key licence end_date broker api_key outgoing_ip agent_url dedicated_ip_enabled api_key_ip_pair_verified validated_route_ip validated_route_type is_online is_login"
      )
      .lean();

    if (session) usersQuery.session(session);
    const users = await usersQuery;
    const readinessMap = await this.buildReadinessMap(users as any[]);

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
    const now = new Date();

    const markFailure = async (
      user: any,
      clientOrderId: string,
      correlationId: string,
      reason: string
    ) => {
      const networkMeta = resolveUserNetworkMeta(user);

      await SignalExecutionResult.findOneAndUpdate(
        { signalId, userId: user?._id },
        {
          signalId,
          userId: user?._id,
          clientOrderId,
          broker: user?.broker || "ANGELONE",
          status: "FAILED",
          errorMessage: reason,
          correlationId,
          source: "SERVER_QUEUE",
          executedAt: new Date(),
          ipAddress: networkMeta.usedIpLabel,
        },
        {
          upsert: true,
          new: true,
          session,
          setDefaultsOnInsert: true,
        }
      );

      try {
        const doc = {
          userId: String(user?._id || ""),
          clientcode: "UNKNOWN",
          tradingsymbol: signal?.tradingsymbol || "UNKNOWN",
          orderid: "SKIPPED",
          action: "SKIP_EXECUTION",
          status: "REJECTED",
          message: reason,
          usedIp: networkMeta.usedIp,
          networkRoute: networkMeta.networkRoute,
          brokerError: {
            reason,
            signalId: String(signalId),
            usedIp: networkMeta.usedIpLabel,
            networkRoute: networkMeta.networkRoute,
          },
        };

        if (session) {
          await BrokerResponse.create([doc], { session });
        } else {
          await BrokerResponse.create(doc);
        }
      } catch (logErr: any) {
        log.warn("[SignalBroadcastService] Failed to write BrokerResponse for skip", {
          userId: String(user?._id || ""),
          signalId: String(signalId),
          message: logErr?.message,
        });
      }
    };

    const processUser = async (user: any, index: number) => {
      const clientOrderId = `AUTO-${String(signalId).slice(-4)}-${String(user._id).slice(-4)}-${Date.now()
        .toString()
        .slice(-4)}-${index}`;
      const correlationId = `${batchCorrelationId}:${index}`;
      const userName = user.user_name || user.email || String(user._id);
      const networkMeta = resolveUserNetworkMeta(user);

      const userLicence = String(user.licence || "Live").toLowerCase();
      const isLive = userLicence === "live";
      const eligibility = checkUserEligibility(user, now);
      const readiness = readinessMap.get(String(user?._id || ""));

      if (!eligibility.eligible) {
        failedCount += 1;
        const reason = eligibility.reason || "User not eligible for execution";
        await markFailure(user, clientOrderId, correlationId, reason);
        executions.push({
          userName,
          licence: user.licence || "Live",
          status: "FAILED",
          message: reason,
          usedIp: networkMeta.usedIpLabel,
          networkRoute: networkMeta.networkRoute,
        });
        return;
      }

      if (readiness && readiness.ready === false) {
        failedCount += 1;
        const reason = String(readiness.reason || "User broker route not ready for server-side execution");
        await markFailure(user, clientOrderId, correlationId, reason);
        executions.push({
          userName,
          licence: user.licence || "Live",
          status: "FAILED",
          message: reason,
          usedIp: networkMeta.usedIpLabel,
          networkRoute: networkMeta.networkRoute,
        });
        return;
      }

      const rawClientCode = user.client_key ? decrypt(user.client_key) : "";
      if (!rawClientCode || rawClientCode.trim().length < 3) {
        failedCount += 1;
        await markFailure(user, clientOrderId, correlationId, "Client code missing or invalid");
        executions.push({
          userName,
          licence: user.licence || "Live",
          status: "FAILED",
          message: "Client code missing or invalid",
          usedIp: networkMeta.usedIpLabel,
          networkRoute: networkMeta.networkRoute,
        });
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
              outgoingIp: Boolean(user.dedicated_ip_enabled) ? (user.outgoing_ip || undefined) : undefined,
              agentUrl: Boolean(user.dedicated_ip_enabled) ? (user.agent_url || undefined) : undefined,
              dedicatedIpEnabled: Boolean(user.dedicated_ip_enabled === true),
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
        usedIp: networkMeta.usedIpLabel,
        networkRoute: networkMeta.networkRoute,
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
        const networkMeta = resolveUserNetworkMeta(user);

        failedCount += 1;
        executions.push({
          userName,
          licence: user?.licence || "Live",
          status: "FAILED",
          message: reason,
          usedIp: networkMeta.usedIpLabel,
          networkRoute: networkMeta.networkRoute,
        });

        SignalExecutionResult.findOneAndUpdate(
          { signalId, userId: user?._id },
          {
            $set: {
              status: "FAILED",
              errorMessage: reason,
              executedAt: new Date(),
              ipAddress: networkMeta.usedIpLabel,
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
