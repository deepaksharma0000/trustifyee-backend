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
import { apiKeyFingerprint } from "../utils/apiKeyRouteBinding";
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

  // CHECK 7: Per-user IP whitelist + route verification (Angel One)
  if (String(user.broker || "").toUpperCase() === "ANGELONE") {
    const serverIp = config.publicIp || process.env.ANGEL_CLIENT_PUBLIC_IP || "";
    const apiKeyIpVerified = Boolean((user as any).api_key_ip_pair_verified);
    const validatedRouteIp = String((user as any).validated_route_ip || "").trim();
    const validatedFp = String((user as any).validated_api_key_fingerprint || "").trim();

    checks.push({
      name: "IP_PAIR_VERIFIED",
      passed: apiKeyIpVerified,
      detail: apiKeyIpVerified
        ? `API key/IP pair verified (route: ${validatedRouteIp || serverIp || "shared"})`
        : `API key/IP pair not verified — user must whitelist server IP ${serverIp || "PUBLIC_IP"} on their own SmartAPI app and reconnect`,
      severity: apiKeyIpVerified ? "INFO" : "WARNING",
    });

    if (serverIp && validatedRouteIp && validatedRouteIp !== serverIp && !(user as any).dedicated_ip_enabled) {
      checks.push({
        name: "ROUTE_IP_ALIGNED",
        passed: false,
        detail: `validated_route_ip=${validatedRouteIp} differs from PUBLIC_IP=${serverIp} — reconnect after whitelisting VPS IP`,
        severity: "WARNING",
      });
    }

    if (user.api_key && validatedFp) {
      try {
        const profileKey = decrypt(user.api_key);
        const runtimeFp = apiKeyFingerprint(profileKey);
        const fpMatch = runtimeFp === validatedFp;
        checks.push({
          name: "API_KEY_FINGERPRINT_MATCH",
          passed: fpMatch,
          detail: fpMatch
            ? `Fingerprint match (${runtimeFp})`
            : `Fingerprint mismatch validated=${validatedFp} runtime=${runtimeFp} — API_KEY_ROUTE_MISMATCH risk`,
          severity: fpMatch ? "INFO" : "CRITICAL",
        });
        if (!fpMatch) {
          criticalIssue = criticalIssue || "API_KEY_FINGERPRINT_MISMATCH";
          actionRequired =
            actionRequired ||
            "User must reconnect via Profile → Broker Connect with their own SmartAPI Private Key.";
        }
      } catch {
        checks.push({
          name: "API_KEY_FINGERPRINT_MATCH",
          passed: false,
          detail: "Could not decrypt user api_key for fingerprint check",
          severity: "CRITICAL",
        });
      }
    }

    if ((user as any).requiresReconnect === true) {
      checks.push({
        name: "BROKER_RECONNECT_REQUIRED",
        passed: false,
        detail: "requiresReconnect flag set — user must reconnect after API key migration",
        severity: "CRITICAL",
      });
      criticalIssue = criticalIssue || "BROKER_RECONNECT_REQUIRED";
      actionRequired = actionRequired || "User must reconnect broker from Profile → Broker Connect.";
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

  if (!serverIp || serverIp === "UNKNOWN") {
    return `[ACTION REQUIRED] PUBLIC_IP is not set in .env. Angel One requires X-ClientPublicIP header. Set PUBLIC_IP=<your VPS IP> in .env.`;
  }

  return [
    `[WHITELIST CHECK] Per-user SmartAPI Private Key mode (Working System A).`,
    `Server egress IP: ${serverIp}`,
    `ACTION: Each user must whitelist IP ${serverIp} on their own SmartAPI app at https://smartapi.angelone.in → My Apps.`,
    `Then reconnect via Profile → Broker Connect so api_key_ip_pair_verified is set.`,
  ].join("\n");
}
