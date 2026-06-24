/**
 * Automated production-readiness validation for Angel One multi-user trading.
 * Used by GET /api/admin/production-readiness and scripts/go-live-verify.ts
 */
import User from "../models/User";
import AngelTokensModel from "../models/AngelTokens";
import { config } from "../config";
import { decrypt, ensureEncrypted } from "../utils/encryption";
import { apiKeyFingerprint } from "../utils/apiKeyRouteBinding";
import { shouldUsePlatformAngelApiKey } from "../utils/platformAngelApiKey";
import { tickEngineService } from "./TickEngineService";
import { getSystemDataScopeUserId } from "./AngelAdapterRegistry";

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const STALE_SESSION_HOURS = 20;
const WORKER_CONCURRENCY = 5;
const WORKER_RATE_MAX = 9;
const WORKER_RATE_DURATION_MS = 1000;
const ANGEL_OPS_PER_KEY = 10;

export type GoLiveCheck = {
  id: string;
  category: "CODE" | "CONFIG" | "USER" | "CAPACITY" | "SYSTEM_DATA";
  pass: boolean;
  severity: "CRITICAL" | "WARNING" | "INFO";
  detail: string;
  userId?: string;
  clientCode?: string;
  email?: string;
};

export type UserTradingReadiness = {
  userId: string;
  email: string | null;
  clientCode: string | null;
  brokerConnected: boolean;
  requiresReconnect: boolean;
  fingerprintMatch: boolean;
  likelyPlatformEraFingerprint: boolean;
  tokenApiKeyMatchesProfile: boolean;
  apiKeyIpPairVerified: boolean;
  validatedRouteIp: string | null;
  expectedServerIp: string;
  ipRouteAligned: boolean;
  jwtPresent: boolean;
  refreshPresent: boolean;
  feedPresent: boolean;
  sessionStale: boolean;
  tokenAgeMinutes: number | null;
  precheckWouldPass: boolean;
  blockers: string[];
};

export type ProductionReadinessReport = {
  generatedAt: string;
  perUserApiKeyMode: true;
  platformKeyForUserTrading: false;
  serverEgressIp: string;
  strictRouteValidation: boolean;
  productionReadinessScore: number;
  approvalStatus: "APPROVED" | "CONDITIONAL" | "BLOCKED";
  codeInvariants: Record<string, boolean>;
  capacity: {
    workerConcurrencyPerQueue: number;
    workerRateLimitPerSecond: number;
    estimatedConcurrentUsers100: string;
    estimatedConcurrentUsers500: string;
    oneVpsIpMultiUser: boolean;
    perUserSmartApiApps: boolean;
  };
  userSummary: {
    totalAngelUsers: number;
    liveConnected: number;
    readyForTrading: number;
    fingerprintMismatch: number;
    requiresReconnect: number;
    staleSessions: number;
    ipNotVerified: number;
    likelyPlatformEra: number;
  };
  users: UserTradingReadiness[];
  checks: GoLiveCheck[];
  blockers: string[];
  requiredUserActions: string[];
  requiredAdminActions: string[];
};

function ageMinutes(from?: Date | null): number | null {
  if (!from) return null;
  const ms = Date.now() - new Date(from).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 60_000);
}

function normalizeIpv4(value?: string): string {
  const t = String(value || "").trim();
  return IPV4_RE.test(t) ? t : "";
}

export async function runProductionGoLiveValidation(): Promise<ProductionReadinessReport> {
  const checks: GoLiveCheck[] = [];
  const blockers: string[] = [];
  const requiredUserActions: string[] = [];
  const requiredAdminActions: string[] = [];

  const serverIp = normalizeIpv4(config.publicIp) || normalizeIpv4(process.env.ANGEL_CLIENT_PUBLIC_IP || "");
  const strictRoute = process.env.STRICT_API_KEY_ROUTE_VALIDATION === "true";
  const platformFp = apiKeyFingerprint(config.angelApiKey || "");

  const codeInvariants: Record<string, boolean> = {
    shouldUsePlatformAngelApiKeyAlwaysFalse: shouldUsePlatformAngelApiKey() === false,
    usePlatformAngelApiKeyConfigFalse: config.usePlatformAngelApiKey === false,
    forceSharedVpsRoute: config.forceSharedVpsRoute === true,
    allowGlobalApiKeyFallbackDisabled: process.env.ALLOW_GLOBAL_ANGEL_API_KEY_FALLBACK !== "true",
    allowGlobalSessionFallbackDisabled: process.env.ALLOW_GLOBAL_SESSION_FALLBACK !== "true",
  };

  for (const [key, ok] of Object.entries(codeInvariants)) {
    checks.push({
      id: `CODE_${key}`,
      category: "CODE",
      pass: ok,
      severity: ok ? "INFO" : "CRITICAL",
      detail: ok ? `${key}=OK` : `${key} FAILED — user trading must never use platform key or shared session fallback`,
    });
    if (!ok) blockers.push(`Code invariant failed: ${key}`);
  }

  if (!serverIp) {
    checks.push({
      id: "CONFIG_PUBLIC_IP",
      category: "CONFIG",
      pass: false,
      severity: "CRITICAL",
      detail: "PUBLIC_IP is not set — Angel One requires X-ClientPublicIP for shared VPS routing",
    });
    blockers.push("PUBLIC_IP not configured");
    requiredAdminActions.push("Set PUBLIC_IP=147.93.18.15 (or actual VPS egress) in production .env");
  } else {
    checks.push({
      id: "CONFIG_PUBLIC_IP",
      category: "CONFIG",
      pass: true,
      severity: "INFO",
      detail: `PUBLIC_IP=${serverIp} (shared VPS egress for all per-user SmartAPI apps)`,
    });
  }

  if (process.env.USE_PLATFORM_ANGEL_API_KEY === "true") {
    checks.push({
      id: "CONFIG_USE_PLATFORM_ANGEL_API_KEY",
      category: "CONFIG",
      pass: false,
      severity: "WARNING",
      detail: "USE_PLATFORM_ANGEL_API_KEY=true in .env but code ignores it for trading — remove or set false to avoid operator confusion",
    });
    requiredAdminActions.push("Set USE_PLATFORM_ANGEL_API_KEY=false in .env");
  }

  const dataScopeUserId = getSystemDataScopeUserId();
  const dataClient = String(config.dataClientCode || "").trim();
  const dataToken = await AngelTokensModel.findOne({ userId: dataScopeUserId, clientcode: dataClient }).lean();
  const feed = tickEngineService.getSystemDataAuditSnapshot();

  checks.push({
    id: "SYSTEM_DATA_SCOPE",
    category: "SYSTEM_DATA",
    pass: Boolean(dataScopeUserId && dataClient && config.dataApiKey),
    severity: "CRITICAL",
    detail: dataScopeUserId
      ? `SYSTEM_DATA_SCOPE_USER_ID=${dataScopeUserId} DATA_CLIENT_CODE=${dataClient}`
      : "SYSTEM_DATA_SCOPE_USER_ID or DATA_CLIENT_CODE missing",
  });

  checks.push({
    id: "SYSTEM_DATA_TOKEN",
    category: "SYSTEM_DATA",
    pass: Boolean(dataToken?.jwtToken),
    severity: "WARNING",
    detail: dataToken ? "Scoped AngelTokens row exists for TickEngine" : "Missing scoped AngelTokens — start backend to create",
  });

  checks.push({
    id: "SYSTEM_DATA_WS",
    category: "SYSTEM_DATA",
    pass: feed.websocketConnected === true,
    severity: "WARNING",
    detail: `TickEngine websocketConnected=${feed.websocketConnected} marketFeedStatus=${feed.marketFeedStatus}`,
  });

  const users = await User.find({ broker: { $regex: /^angelone$/i } })
    .select(
      "user_name email client_key api_key broker_connected broker_verified requiresReconnect licence " +
        "api_key_ip_pair_verified validated_api_key_fingerprint validated_route_ip validated_route_type validated_pair_at"
    )
    .lean();

  const userIds = users.map((u) => u._id);
  const tokens = await AngelTokensModel.find({ userId: { $in: userIds } }).lean();
  const tokenByUserClient = new Map<string, any>();
  for (const t of tokens) {
    tokenByUserClient.set(`${String(t.userId)}:${String(t.clientcode).toUpperCase()}`, t);
  }

  const userRows: UserTradingReadiness[] = [];

  for (const user of users) {
    const userId = String(user._id);
    let clientCode = "";
    try {
      if (user.client_key) {
        clientCode = (await ensureEncrypted(user as any, "client_key", `golive_${userId}`)).toUpperCase();
      }
    } catch {
      clientCode = "";
    }

    const tokenDoc = clientCode
      ? tokenByUserClient.get(`${userId}:${clientCode}`)
      : tokens.find((t) => String(t.userId) === userId);

    let profileApiKey = "";
    let tokenApiKey = "";
    try {
      if (user.api_key) profileApiKey = await ensureEncrypted(user as any, "api_key", `golive_api_${userId}`);
      if (tokenDoc?.apiKey) tokenApiKey = decrypt(String(tokenDoc.apiKey));
    } catch {
      /* decrypt errors handled below */
    }

    const runtimeFp = profileApiKey ? apiKeyFingerprint(profileApiKey) : "EMPTY";
    const tokenFp = tokenApiKey ? apiKeyFingerprint(tokenApiKey) : "EMPTY";
    const validatedFp = String((user as any).validated_api_key_fingerprint || "").trim() || null;
    const fingerprintMatch = Boolean(validatedFp && runtimeFp !== "EMPTY" && validatedFp === runtimeFp);
    const likelyPlatformEra = Boolean(validatedFp && validatedFp === platformFp && runtimeFp !== platformFp && runtimeFp !== "EMPTY");
    const tokenApiKeyMatchesProfile = !profileApiKey || !tokenApiKey || profileApiKey === tokenApiKey;
    const validatedRouteIp = String((user as any).validated_route_ip || "").trim() || null;
    const ipRouteAligned =
      !validatedRouteIp ||
      !serverIp ||
      normalizeIpv4(validatedRouteIp) === serverIp ||
      Boolean((user as any).dedicated_ip_enabled);

    const tokenUpdatedAt = tokenDoc?.updatedAt ? new Date(tokenDoc.updatedAt) : null;
    const tokenAgeMin = ageMinutes(tokenUpdatedAt);
    const sessionStale = tokenAgeMin !== null && tokenAgeMin > STALE_SESSION_HOURS * 60;

    const jwtPresent = Boolean(tokenDoc?.jwtToken);
    const refreshPresent = Boolean(tokenDoc?.refreshToken);
    const feedPresent = Boolean(tokenDoc?.feedToken);
    const apiKeyIpPairVerified = Boolean((user as any).api_key_ip_pair_verified);
    const requiresReconnect = Boolean((user as any).requiresReconnect);
    const brokerConnected = Boolean(user.broker_connected);
    const isLive = String(user.licence || "Live").toLowerCase() === "live";

    const userBlockers: string[] = [];
    if (requiresReconnect) userBlockers.push("requiresReconnect flag set");
    if (isLive && !brokerConnected) userBlockers.push("broker not connected");
    if (isLive && !profileApiKey) userBlockers.push("missing SmartAPI Private Key");
    if (isLive && !clientCode) userBlockers.push("missing client code");
    if (isLive && !jwtPresent) userBlockers.push("missing JWT in AngelTokens");
    if (isLive && !refreshPresent) userBlockers.push("missing refresh token");
    if (isLive && !feedPresent) userBlockers.push("missing feed token");
    if (isLive && !tokenApiKeyMatchesProfile) userBlockers.push("AngelTokens.apiKey !== User.api_key");
    if (isLive && likelyPlatformEra) userBlockers.push("validated fingerprint matches legacy platform key era");
    if (isLive && validatedFp && !fingerprintMatch) userBlockers.push("API key fingerprint mismatch vs validated_api_key_fingerprint");
    if (isLive && strictRoute && !apiKeyIpPairVerified) userBlockers.push("api_key_ip_pair_verified=false");
    if (isLive && strictRoute && serverIp && validatedRouteIp && !ipRouteAligned) userBlockers.push("validated_route_ip !== PUBLIC_IP");
    if (isLive && sessionStale) userBlockers.push(`session older than ${STALE_SESSION_HOURS}h — refresh or reconnect`);

    const precheckWouldPass =
      brokerConnected &&
      !requiresReconnect &&
      fingerprintMatch &&
      apiKeyIpPairVerified &&
      Boolean(validatedRouteIp || serverIp) &&
      tokenApiKeyMatchesProfile &&
      jwtPresent &&
      userBlockers.length === 0;

    userRows.push({
      userId,
      email: user.email || null,
      clientCode: clientCode || tokenDoc?.clientcode || null,
      brokerConnected,
      requiresReconnect,
      fingerprintMatch,
      likelyPlatformEraFingerprint: likelyPlatformEra,
      tokenApiKeyMatchesProfile,
      apiKeyIpPairVerified,
      validatedRouteIp,
      expectedServerIp: serverIp,
      ipRouteAligned,
      jwtPresent,
      refreshPresent,
      feedPresent,
      sessionStale,
      tokenAgeMinutes: tokenAgeMin,
      precheckWouldPass,
      blockers: userBlockers,
    });

    if (isLive && brokerConnected) {
      if (likelyPlatformEra) {
        checks.push({
          id: `USER_PLATFORM_ERA_FP_${userId}`,
          category: "USER",
          pass: false,
          severity: "CRITICAL",
          detail: `validated_api_key_fingerprint matches platform ANGEL_API_KEY era — reconnect required`,
          userId,
          clientCode: clientCode || undefined,
          email: user.email || undefined,
        });
        requiredUserActions.push(
          `${user.email || userId}: Reconnect Broker Connect with own SmartAPI Private Key + whitelist ${serverIp}`
        );
      } else if (validatedFp && !fingerprintMatch) {
        checks.push({
          id: `USER_FP_MISMATCH_${userId}`,
          category: "USER",
          pass: false,
          severity: "CRITICAL",
          detail: `fingerprint expected=${validatedFp} runtime=${runtimeFp}`,
          userId,
          clientCode: clientCode || undefined,
          email: user.email || undefined,
        });
        requiredUserActions.push(`${user.email || userId}: Reconnect broker — API_KEY_ROUTE_MISMATCH risk`);
      }

      if (!tokenApiKeyMatchesProfile) {
        checks.push({
          id: `USER_TOKEN_KEY_DRIFT_${userId}`,
          category: "USER",
          pass: false,
          severity: "CRITICAL",
          detail: "AngelTokens.apiKey !== User.api_key — BROKER_API_KEY_TOKEN_MISMATCH",
          userId,
          clientCode: clientCode || undefined,
          email: user.email || undefined,
        });
      }

      if (requiresReconnect) {
        checks.push({
          id: `USER_RECONNECT_${userId}`,
          category: "USER",
          pass: false,
          severity: "CRITICAL",
          detail: "requiresReconnect=true after migration",
          userId,
          clientCode: clientCode || undefined,
          email: user.email || undefined,
        });
      }

      if (strictRoute && !apiKeyIpPairVerified) {
        checks.push({
          id: `USER_IP_NOT_VERIFIED_${userId}`,
          category: "USER",
          pass: false,
          severity: "CRITICAL",
          detail: `Whitelist ${serverIp} on user's SmartAPI app then reconnect`,
          userId,
          clientCode: clientCode || undefined,
          email: user.email || undefined,
        });
        requiredUserActions.push(`${user.email || userId}: Whitelist ${serverIp} on own Angel SmartAPI app`);
      }

      if (sessionStale) {
        checks.push({
          id: `USER_STALE_SESSION_${userId}`,
          category: "USER",
          pass: false,
          severity: "WARNING",
          detail: `Token age ${tokenAgeMin} minutes — proactive refresh recommended`,
          userId,
          clientCode: clientCode || undefined,
          email: user.email || undefined,
        });
      }
    }
  }

  const liveUsers = userRows.filter((u) => users.find((x) => String(x._id) === u.userId && String(x.licence || "Live").toLowerCase() === "live"));
  const liveConnected = liveUsers.filter((u) => u.brokerConnected).length;
  const readyForTrading = liveUsers.filter((u) => u.precheckWouldPass).length;
  const fingerprintMismatch = liveUsers.filter((u) => u.brokerConnected && !u.fingerprintMatch && Boolean(u.blockers.some((b) => b.includes("fingerprint")))).length;
  const requiresReconnectCount = liveUsers.filter((u) => u.requiresReconnect).length;
  const staleSessions = liveUsers.filter((u) => u.sessionStale).length;
  const ipNotVerified = liveUsers.filter((u) => u.brokerConnected && !u.apiKeyIpPairVerified).length;
  const likelyPlatformEra = liveUsers.filter((u) => u.likelyPlatformEraFingerprint).length;

  if (requiresReconnectCount > 0) {
    blockers.push(`${requiresReconnectCount} user(s) flagged requiresReconnect`);
    requiredAdminActions.push("Run: npx ts-node scripts/force-broker-reconnect.ts then notify users to reconnect");
  }
  if (likelyPlatformEra > 0) {
    blockers.push(`${likelyPlatformEra} user(s) have platform-era validated fingerprint`);
  }
  if (fingerprintMismatch > 0) {
    blockers.push(`${fingerprintMismatch} user(s) have API key fingerprint mismatch`);
  }

  const jobsPerSecondCapacity = WORKER_RATE_MAX / (WORKER_RATE_DURATION_MS / 1000);
  checks.push({
    id: "CAPACITY_100_USERS",
    category: "CAPACITY",
    pass: true,
    severity: "INFO",
    detail: `BullMQ worker concurrency=${WORKER_CONCURRENCY}/queue, rate=${WORKER_RATE_MAX}/sec. 100-user broadcast queues 100 jobs — serialized by per-key rate limit (~${ANGEL_OPS_PER_KEY} OPS Angel limit). Expected: viable with throttling.`,
  });
  checks.push({
    id: "CAPACITY_500_USERS",
    category: "CAPACITY",
    pass: true,
    severity: "WARNING",
    detail: `500-user broadcast = 500 BullMQ jobs. At ~${jobsPerSecondCapacity} jobs/sec worker throughput, full fan-out ~${Math.ceil(500 / jobsPerSecondCapacity)}s minimum. Requires prod load test + Redis scaling.`,
  });
  checks.push({
    id: "CAPACITY_ONE_VPS_IP",
    category: "CAPACITY",
    pass: Boolean(serverIp),
    severity: "INFO",
    detail: serverIp
      ? `One VPS IP ${serverIp} supports many users — each whitelists same IP on their own SmartAPI app (Working System A model)`
      : "PUBLIC_IP required",
  });

  const totalChecks = checks.length;
  const passedChecks = checks.filter((c) => c.pass).length;
  const criticalFails = checks.filter((c) => !c.pass && c.severity === "CRITICAL").length;
  const codeOk = Object.values(codeInvariants).every(Boolean);
  const usersOk = liveConnected === 0 || readyForTrading === liveConnected;

  let score = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0;
  if (!codeOk) score = Math.min(score, 40);
  if (criticalFails > 0) score = Math.min(score, 60);
  if (liveConnected > 0 && readyForTrading < liveConnected) {
    score = Math.min(score, Math.round((readyForTrading / Math.max(liveConnected, 1)) * 80));
  }

  let approvalStatus: ProductionReadinessReport["approvalStatus"] = "APPROVED";
  if (!codeOk || criticalFails > 0 || blockers.length > 0) {
    approvalStatus = liveConnected === 0 && codeOk ? "CONDITIONAL" : "BLOCKED";
  } else if (liveConnected > 0 && readyForTrading < liveConnected) {
    approvalStatus = "CONDITIONAL";
  }

  if (approvalStatus === "BLOCKED" && blockers.length === 0) {
    blockers.push("One or more CRITICAL checks failed");
  }

  return {
    generatedAt: new Date().toISOString(),
    perUserApiKeyMode: true,
    platformKeyForUserTrading: false,
    serverEgressIp: serverIp,
    strictRouteValidation: strictRoute,
    productionReadinessScore: score,
    approvalStatus,
    codeInvariants,
    capacity: {
      workerConcurrencyPerQueue: WORKER_CONCURRENCY,
      workerRateLimitPerSecond: WORKER_RATE_MAX,
      estimatedConcurrentUsers100: "Supported — BullMQ fan-out + per-key rate limit (TradeExecutionWorker.ts:598-600)",
      estimatedConcurrentUsers500: "Theoretical — requires production load test; ~56s minimum queue drain at 9 jobs/sec",
      oneVpsIpMultiUser: Boolean(serverIp),
      perUserSmartApiApps: true,
    },
    userSummary: {
      totalAngelUsers: users.length,
      liveConnected,
      readyForTrading,
      fingerprintMismatch,
      requiresReconnect: requiresReconnectCount,
      staleSessions,
      ipNotVerified,
      likelyPlatformEra,
    },
    users: userRows,
    checks,
    blockers: [...new Set(blockers)],
    requiredUserActions: [...new Set(requiredUserActions)],
    requiredAdminActions: [...new Set(requiredAdminActions)],
  };
}
