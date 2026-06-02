/**
 * brokerHealthDiagnostics.ts
 *
 * Centralized pre-trade health checker for Angel One broker sessions.
 * Provides clear, actionable diagnostics so errors surface with context
 * instead of cryptic AG8001/AG8004 codes from the broker.
 */

import AngelTokensModel from "../models/AngelTokens";
import User from "../models/User";
import { config } from "../config";
import { decrypt } from "../utils/encryption";
import log from "../utils/logger";

export type BrokerHealthResult = {
  healthy: boolean;
  userId: string;
  clientcode: string;
  checks: BrokerHealthCheck[];
  criticalIssue?: string;
  actionRequired?: string;
};

export type BrokerHealthCheck = {
  name: string;
  passed: boolean;
  detail: string;
  severity: "CRITICAL" | "WARNING" | "INFO";
};

const IP_EXPIRY_LOOKAHEAD_MS = 30 * 60 * 1000; // Warn 30min before expiry

/**
 * Run a full pre-trade broker health check for a user.
 * Call this from SignalBroadcastService before queuing to surface
 * actionable errors instead of cryptic broker rejections.
 */
export async function checkBrokerHealthForUser(userId: string): Promise<BrokerHealthResult> {
  const checks: BrokerHealthCheck[] = [];
  let criticalIssue: string | undefined;
  let actionRequired: string | undefined;

  const user = await User.findById(userId)
    .select(
      "broker broker_connected trading_status status licence api_key client_key dedicated_ip_enabled outgoing_ip agent_url api_key_ip_pair_verified validated_route_ip"
    )
    .lean();

  if (!user) {
    return {
      healthy: false,
      userId,
      clientcode: "UNKNOWN",
      checks: [{ name: "USER_FOUND", passed: false, detail: "User document not found in database", severity: "CRITICAL" }],
      criticalIssue: "USER_NOT_FOUND",
      actionRequired: "Contact administrator — user account does not exist.",
    };
  }

  const clientcode = user.client_key ? decrypt(user.client_key) : "";

  // CHECK 1: User account is active
  checks.push({
    name: "ACCOUNT_ACTIVE",
    passed: user.status === "active",
    detail: `User status: ${user.status}`,
    severity: "CRITICAL",
  });

  // CHECK 2: Broker is connected
  checks.push({
    name: "BROKER_CONNECTED",
    passed: Boolean(user.broker_connected),
    detail: user.broker_connected
      ? "Broker connection verified"
      : "Broker not connected — user needs to reconnect from profile settings",
    severity: "CRITICAL",
  });
  if (!user.broker_connected) {
    criticalIssue = "BROKER_NOT_CONNECTED";
    actionRequired = "Ask the user to go to Profile → Broker Settings and reconnect their Angel One account.";
  }

  // CHECK 3: Trading is enabled
  checks.push({
    name: "TRADING_ENABLED",
    passed: user.trading_status === "enabled",
    detail: `Trading status: ${user.trading_status}`,
    severity: "CRITICAL",
  });

  // CHECK 4: Client code exists and is valid
  checks.push({
    name: "CLIENT_CODE_VALID",
    passed: Boolean(clientcode && clientcode.trim().length >= 3),
    detail: clientcode ? `Client code: ${clientcode.slice(0, 2)}***` : "Client code missing or invalid",
    severity: "CRITICAL",
  });

  // CHECK 5: AngelTokens session exists with JWT
  const session = await AngelTokensModel.findOne({
    userId,
    jwtToken: { $exists: true, $ne: "" },
  })
    .sort({ updatedAt: -1 })
    .lean();

  checks.push({
    name: "SESSION_EXISTS",
    passed: Boolean(session),
    detail: session ? "Active JWT session found in database" : "No JWT session — user must login to broker",
    severity: "CRITICAL",
  });

  if (session) {
    // CHECK 6: Session not expired (or expiring soon)
    const expiresAt = session?.expiresAt ? new Date(session.expiresAt).getTime() : 0;
    const now = Date.now();
    const expiresInMs = expiresAt - now;
    const isExpiring = expiresAt > 0 && expiresInMs <= IP_EXPIRY_LOOKAHEAD_MS;
    const isExpired = expiresAt > 0 && expiresInMs <= 0;

    checks.push({
      name: "SESSION_NOT_EXPIRED",
      passed: !isExpired,
      detail: isExpired
        ? "JWT session is EXPIRED — refresh needed"
        : isExpiring
        ? `JWT session expires in ${Math.round(expiresInMs / 60000)} minutes — refresh pending`
        : `JWT session valid for ${Math.round(expiresInMs / 3600000)} hours`,
      severity: isExpired ? "CRITICAL" : isExpiring ? "WARNING" : "INFO",
    });
  }

  // CHECK 7: IP whitelist configuration (Angel One specific)
  if (String(user.broker || "").toUpperCase() === "ANGELONE") {
    const serverIp = config.publicIp || process.env.ANGEL_CLIENT_PUBLIC_IP || "";
    const usePlatformKey = process.env.USE_PLATFORM_ANGEL_API_KEY === "true";

    if (usePlatformKey) {
      checks.push({
        name: "IP_WHITELIST_PLATFORM_KEY",
        passed: Boolean(serverIp),
        detail: serverIp
          ? `Platform key mode: ensure IP ${serverIp} is whitelisted in Angel One SmartAPI portal for app key ${String(process.env.ANGEL_API_KEY || "").slice(-4).padStart(8, "*")}`
          : "Server IP not configured — set PUBLIC_IP in .env",
        severity: serverIp ? "WARNING" : "CRITICAL",
      });
    } else {
      const apiKeyIpVerified = Boolean((user as any).api_key_ip_pair_verified);
      checks.push({
        name: "IP_PAIR_VERIFIED",
        passed: apiKeyIpVerified,
        detail: apiKeyIpVerified
          ? `API key/IP pair verified (route: ${(user as any).validated_route_ip || "shared"})`
          : "API key/IP pair not verified — user must reconnect broker once after whitelisting server IP",
        severity: apiKeyIpVerified ? "INFO" : "WARNING",
      });
    }
  }

  const hasCriticalFailure = checks.some((c) => c.severity === "CRITICAL" && !c.passed);

  return {
    healthy: !hasCriticalFailure,
    userId,
    clientcode,
    checks,
    criticalIssue,
    actionRequired,
  };
}

/**
 * Batch health check for all users in a signal broadcast.
 * Returns a summary + per-user breakdown.
 */
export async function checkBrokerHealthBatch(
  userIds: string[]
): Promise<{ healthy: string[]; unhealthy: string[]; details: Map<string, BrokerHealthResult> }> {
  const details = new Map<string, BrokerHealthResult>();
  const healthy: string[] = [];
  const unhealthy: string[] = [];

  await Promise.allSettled(
    userIds.map(async (uid) => {
      try {
        const result = await checkBrokerHealthForUser(uid);
        details.set(uid, result);
        if (result.healthy) healthy.push(uid);
        else unhealthy.push(uid);
      } catch (err: any) {
        log.warn("[BrokerHealthDiagnostics] Check failed for user", { userId: uid, message: err?.message });
        details.set(uid, {
          healthy: false,
          userId: uid,
          clientcode: "UNKNOWN",
          checks: [{ name: "CHECK_ERROR", passed: false, detail: err?.message || "Diagnostic check threw", severity: "CRITICAL" }],
          criticalIssue: "DIAGNOSTIC_ERROR",
        });
        unhealthy.push(uid);
      }
    })
  );

  return { healthy, unhealthy, details };
}

/**
 * Quick IP whitelist check — generates a clear diagnostic message for logs.
 */
export function buildIpWhitelistActionPlan(): string {
  const serverIp = config.publicIp || process.env.ANGEL_CLIENT_PUBLIC_IP || "UNKNOWN";
  const apiKey = process.env.ANGEL_API_KEY || "NOT_SET";
  const usePlatformKey = process.env.USE_PLATFORM_ANGEL_API_KEY === "true";

  if (!serverIp || serverIp === "UNKNOWN") {
    return `[ACTION REQUIRED] PUBLIC_IP is not set in .env. Angel One requires X-ClientPublicIP header. Set PUBLIC_IP=<your VPS IP> in .env.`;
  }

  if (usePlatformKey) {
    return [
      `[WHITELIST CHECK] Using platform Angel API key: ...${apiKey.slice(-4)}`,
      `Server IP: ${serverIp}`,
      `ACTION: Login to https://smartapi.angelone.in → My Apps → Find app with key ending ...${apiKey.slice(-4)} → Whitelist IP: ${serverIp}`,
      `Once whitelisted, all users sharing this key will be able to execute trades.`,
    ].join("\n");
  }

  return [
    `[WHITELIST CHECK] Per-user API key mode active.`,
    `Server IP: ${serverIp}`,
    `ACTION: Each user must whitelist IP ${serverIp} in their own SmartAPI app in the Angel One portal.`,
  ].join("\n");
}
