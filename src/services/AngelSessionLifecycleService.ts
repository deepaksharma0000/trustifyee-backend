import AngelTokensModel from "../models/AngelTokens";
import User from "../models/User";
import Admin from "../models/Admin";
import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import { ensureEncrypted, encrypt, decrypt } from "../utils/encryption";
import log from "../utils/logger";
import { invalidateAngelSessionCache, primeAngelSessionCache } from "./AngelSessionContextService";
import { getOrCreateUserAngelAdapter } from "./AngelAdapterRegistry";
import { resolveConsistentApiKey, validateApiKeyFormat } from "./BrokerSessionValidator";
import { resolveRouteBinding } from "../utils/apiKeyRouteBinding";
import { config } from "../config";

type RecoveryMode = "REFRESH" | "RELOGIN";

export type SessionRecoveryResult = {
  ok: boolean;
  mode?: RecoveryMode;
  jwtToken?: string;
  refreshToken?: string;
  feedToken?: string;
  reason?: string;
  errorCode?: string;
  isPermanentFailure?: boolean; // FIX: distinguish permanent vs transient errors
};

const inFlightRecoveries = new Map<string, Promise<SessionRecoveryResult>>();
const recoveryCooldownUntil = new Map<string, number>();
const RECOVERY_COOLDOWN_MS = 60_000;

const toSessionKey = (sessionDoc: any) =>
  String(sessionDoc?._id || `${sessionDoc?.userId || "UNKNOWN"}:${sessionDoc?.clientcode || "UNKNOWN"}`);

/**
 * FIX 6: Classifies Angel One error codes into PERMANENT vs TRANSIENT.
 *
 * PERMANENT failures warrant clearing broker_connected:
 *   - AB1008: Invalid MPIN / max login attempts exceeded
 *   - AG8004: Invalid API key
 *   - Credential validation failures (wrong password, account locked)
 *
 * TRANSIENT failures do NOT warrant clearing broker_connected:
 *   - Network timeouts
 *   - Angel One server 5xx errors
 *   - Rate limiting / temporary service unavailable
 *   - AB1034: Session already active (not a real failure)
 */
function classifyErrorPermanence(reason: string, errorCode?: string): "PERMANENT" | "TRANSIENT" {
  const code = String(errorCode || "").toUpperCase().trim();
  const msg = String(reason || "").toLowerCase();

  // Permanent: account-level issues that won't self-heal
  const permanentCodes = ["AB1008", "AG8004", "AB1010", "AB1011", "AB1012"];
  const permanentMessages = [
    "invalid mpin",
    "invalid password",
    "maximum attempts",
    "account locked",
    "invalid api key",
    "invalid credentials",
    "account suspended",
    "user not found",
    "relogin_missing_required_credentials",
    "profile_not_found_for_relogin",
    "missing_user_id_for_relogin",
  ];

  if (permanentCodes.includes(code)) return "PERMANENT";
  if (permanentMessages.some((m) => msg.includes(m))) return "PERMANENT";

  return "TRANSIENT";
}

function resolveAdapterNetworkOptions(profile?: any) {
  const dedicatedIpEnabled = Boolean(profile?.dedicated_ip_enabled === true);
  const binding = resolveRouteBinding({
    outgoingIp: profile?.outgoing_ip,
    agentUrl: profile?.agent_url,
    dedicatedIpEnabled,
  });

  if (dedicatedIpEnabled) {
    return {
      outgoingIp: binding.routeIp || undefined,
      agentUrl: binding.agentUrl || undefined,
    };
  }

  return {
    outgoingIp: binding.routeIp || config.publicIp || undefined,
    agentUrl: undefined,
  };
}

const extractTokenPayload = (response: any) => {
  const axiosData = response?.data ?? response ?? {};
  const payload = axiosData?.data && typeof axiosData.data === "object" ? axiosData.data : axiosData;

  const jwtToken = payload?.jwtToken || payload?.accessToken || payload?.token;
  const refreshToken = payload?.refreshToken;
  const feedToken = payload?.feedToken || payload?.websocketToken;

  const statusRaw = axiosData?.status;
  const successRaw = axiosData?.success;
  const errorCode = String(
    axiosData?.errorCode || axiosData?.errorcode || payload?.errorCode || payload?.errorcode || ""
  ).toUpperCase();
  const message = String(axiosData?.message || payload?.message || "");

  const ok = Boolean(jwtToken) && (statusRaw === true || successRaw === true || response?.status === 200);

  return { ok, jwtToken, refreshToken, feedToken, errorCode, message, raw: axiosData };
};

const persistRecoveredTokens = async (
  sessionDoc: any,
  tokens: { jwtToken: string; refreshToken?: string; feedToken?: string; apiKey?: string }
) => {
  const updatedPayload: Record<string, unknown> = {
    jwtToken: encrypt(tokens.jwtToken),
    refreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : sessionDoc.refreshToken,
    feedToken: tokens.feedToken ? encrypt(tokens.feedToken) : sessionDoc.feedToken,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  };
  if (tokens.apiKey) {
    updatedPayload.apiKey = encrypt(tokens.apiKey);
  }

  await AngelTokensModel.updateOne(
    { _id: sessionDoc._id },
    {
      $set: updatedPayload,
    }
  );

  invalidateAngelSessionCache(String(sessionDoc?.userId || ""), String(sessionDoc?.clientcode || ""));
  primeAngelSessionCache({
    ...sessionDoc,
    ...updatedPayload,
  });
};

const getProfileWithSecrets = async (userId: string) => {
  const userDoc = await User.findById(userId)
    .select("+broker_password +broker_totp_secret +client_key +api_key +outgoing_ip +agent_url dedicated_ip_enabled")
    .lean();

  if (userDoc) {
    return { type: "user" as const, profile: userDoc };
  }

  const adminDoc = await Admin.findById(userId)
    .select("+broker_password +broker_totp_secret +client_key +api_key +outgoing_ip +panel_client_key")
    .lean();

  if (adminDoc) {
    return { type: "admin" as const, profile: adminDoc };
  }

  return null;
};

async function attemptRefresh(sessionDoc: any, context: string): Promise<SessionRecoveryResult> {
  if (!sessionDoc?.refreshToken) {
    return { ok: false, reason: "NO_REFRESH_TOKEN" };
  }

  const userId = String(sessionDoc?.userId || "");
  const loaded = userId ? await getProfileWithSecrets(userId) : null;
  const resolved = await resolveConsistentApiKey({
    angelTokens: sessionDoc,
    profile: loaded?.profile,
    userId,
    clientcode: String(sessionDoc?.clientcode || ""),
  });
  const sessionApiKey = resolved.apiKey;
  const refreshToken = await ensureEncrypted(sessionDoc, "refreshToken", `${context}_refresh_rt_${sessionDoc.clientcode}`);

  if (!sessionApiKey || !refreshToken) {
    return { ok: false, reason: "REFRESH_MISSING_API_OR_TOKEN" };
  }

  const keyFormat = validateApiKeyFormat(sessionApiKey);
  if (!keyFormat.valid) {
    return { ok: false, reason: `REFRESH_INVALID_API_KEY:${keyFormat.reason}` };
  }

  const adapter = getOrCreateUserAngelAdapter(userId, sessionApiKey, resolveAdapterNetworkOptions(loaded?.profile));
  const response = await adapter.generateTokensUsingRefresh(refreshToken);
  const parsed = extractTokenPayload(response);

  if (!parsed.ok || !parsed.jwtToken) {
    return {
      ok: false,
      reason: parsed.message || "REFRESH_FAILED",
      errorCode: parsed.errorCode,
    };
  }

  await persistRecoveredTokens(sessionDoc, {
    jwtToken: parsed.jwtToken,
    refreshToken: parsed.refreshToken,
    feedToken: parsed.feedToken,
    apiKey: sessionApiKey,
  });

  return {
    ok: true,
    mode: "REFRESH",
    jwtToken: parsed.jwtToken,
    refreshToken: parsed.refreshToken,
    feedToken: parsed.feedToken,
  };
}

async function attemptFreshLogin(sessionDoc: any, context: string): Promise<SessionRecoveryResult> {
  const userId = String(sessionDoc?.userId || "");
  if (!userId) {
    return { ok: false, reason: "MISSING_USER_ID_FOR_RELOGIN", isPermanentFailure: true };
  }

  const loaded = await getProfileWithSecrets(userId);
  if (!loaded?.profile) {
    return { ok: false, reason: "PROFILE_NOT_FOUND_FOR_RELOGIN", isPermanentFailure: true };
  }

  const profile: any = loaded.profile;

  const clientCode = sessionDoc.clientcode || decrypt(profile?.client_key || profile?.panel_client_key || "");
  const password = profile?.broker_password ? decrypt(profile.broker_password, `${context}_pwd`) : "";
  const totpSecret = profile?.broker_totp_secret ? decrypt(profile.broker_totp_secret, `${context}_totp`) : "";

  const resolved = await resolveConsistentApiKey({
    angelTokens: sessionDoc,
    profile,
    userId,
    clientcode: String(sessionDoc?.clientcode || clientCode),
  });
  const apiKey = resolved.apiKey;

  if (!clientCode || !password || !totpSecret || !apiKey) {
    // PERMANENT: Missing credentials — must reconnect from UI
    if (loaded.type === "user") {
      await User.updateOne(
        { _id: userId },
        { $set: { broker_connected: false, broker_verified: false } }
      );
    } else {
      await Admin.updateOne(
        { _id: userId },
        { $set: { broker_connected: false, broker_verified: false } }
      );
    }

    return {
      ok: false,
      reason: "RELOGIN_MISSING_REQUIRED_CREDENTIALS",
      isPermanentFailure: true,
    };
  }

  let loginResponse: any;
  try {
    const adapter = getOrCreateUserAngelAdapter(userId, apiKey, resolveAdapterNetworkOptions(profile));
    loginResponse = await adapter.generateSession({
      clientcode: clientCode,
      password,
      totp: "",
      totp_secret: totpSecret,
    });
  } catch (loginErr: any) {
    const errorMsg = String(loginErr?.message || loginErr?.response?.data?.message || "");
    const errorCode = String(loginErr?.response?.data?.errorcode || "").toUpperCase();
    const permanence = classifyErrorPermanence(errorMsg, errorCode);

    log.warn("[SESSION_RECOVERY] Login HTTP call failed", {
      context,
      userId,
      clientcode: sessionDoc.clientcode,
      errorCode,
      errorMsg,
      permanence,
    });

    // CRITICAL FIX: Only clear broker_connected on PERMANENT failures.
    // Network timeouts, 5xx errors, rate limits are TRANSIENT — clearing broker_connected
    // for transient errors permanently blocks users from receiving signals until manual reconnect.
    if (permanence === "PERMANENT" && loaded.type === "user") {
      log.error("[SESSION_RECOVERY] Permanent credential failure — clearing broker_connected", {
        userId,
        clientcode: sessionDoc.clientcode,
        errorCode,
      });
      await User.updateOne(
        { _id: userId },
        { $set: { broker_connected: false } }
      );
    } else {
      log.warn("[SESSION_RECOVERY] Transient login failure — preserving broker_connected state", {
        userId,
        clientcode: sessionDoc.clientcode,
        errorCode,
        note: "User will be retried on next scheduler tick",
      });
    }

    return {
      ok: false,
      reason: errorMsg || "RELOGIN_HTTP_FAILED",
      errorCode,
      isPermanentFailure: permanence === "PERMANENT",
    };
  }

  const parsed = extractTokenPayload(loginResponse);
  if (!parsed.ok || !parsed.jwtToken) {
    const permanence = classifyErrorPermanence(parsed.message, parsed.errorCode);

    // CRITICAL FIX: Same — only clear broker_connected for permanent broker rejections
    if (permanence === "PERMANENT" && loaded.type === "user") {
      log.error("[SESSION_RECOVERY] Permanent broker rejection on login — clearing broker_connected", {
        userId,
        clientcode: sessionDoc.clientcode,
        errorCode: parsed.errorCode,
        message: parsed.message,
      });
      await User.updateOne(
        { _id: userId },
        { $set: { broker_connected: false } }
      );
    } else if (permanence === "PERMANENT" && loaded.type === "admin") {
      await Admin.updateOne(
        { _id: userId },
        { $set: { broker_connected: false } }
      );
    } else {
      log.warn("[SESSION_RECOVERY] Transient broker login rejection — preserving broker_connected", {
        userId,
        clientcode: sessionDoc.clientcode,
        errorCode: parsed.errorCode,
      });
    }

    return {
      ok: false,
      reason: parsed.message || "RELOGIN_FAILED",
      errorCode: parsed.errorCode,
      isPermanentFailure: permanence === "PERMANENT",
    };
  }

  await persistRecoveredTokens(sessionDoc, {
    jwtToken: parsed.jwtToken,
    refreshToken: parsed.refreshToken,
    feedToken: parsed.feedToken,
    apiKey,
  });

  if (loaded.type === "user") {
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          broker_connected: true,
          broker_verified: true,
          trading_paused: false,
          consecutive_failures: 0,
        },
      }
    );
  }

  return {
    ok: true,
    mode: "RELOGIN",
    jwtToken: parsed.jwtToken,
    refreshToken: parsed.refreshToken,
    feedToken: parsed.feedToken,
  };
}

export async function recoverSessionByRefreshOrLogin(
  sessionDoc: any,
  context: string
): Promise<SessionRecoveryResult> {
  if (!sessionDoc) return { ok: false, reason: "SESSION_DOC_MISSING" };

  const sessionKey = toSessionKey(sessionDoc);
  const now = Date.now();
  const cooldownUntil = recoveryCooldownUntil.get(sessionKey) || 0;

  if (cooldownUntil > now) {
    return {
      ok: false,
      reason: "SESSION_RECOVERY_COOLDOWN",
    };
  }

  if (inFlightRecoveries.has(sessionKey)) {
    return inFlightRecoveries.get(sessionKey)!;
  }

  const recoveryPromise = (async (): Promise<SessionRecoveryResult> => {
    try {
      const refreshResult = await attemptRefresh(sessionDoc, context);
      if (refreshResult.ok) {
        log.info("ANGEL_SESSION_REFRESH_SUCCESS", {
          clientCode: sessionDoc.clientcode,
          mode: "REFRESH",
          context,
        });
        log.info("[SESSION_RECOVERY] Refresh succeeded", {
          context,
          userId: String(sessionDoc.userId || ""),
          clientcode: sessionDoc.clientcode,
        });
        return refreshResult;
      }

      log.warn("[SESSION_RECOVERY] Refresh failed, attempting fresh login", {
        context,
        userId: String(sessionDoc.userId || ""),
        clientcode: sessionDoc.clientcode,
        reason: refreshResult.reason,
        errorCode: refreshResult.errorCode,
      });

      const loginResult = await attemptFreshLogin(sessionDoc, context);
      if (loginResult.ok) {
        log.info("ANGEL_SESSION_REFRESH_SUCCESS", {
          clientCode: sessionDoc.clientcode,
          mode: "RELOGIN",
          context,
        });
        log.info("[SESSION_RECOVERY] Fresh login succeeded", {
          context,
          userId: String(sessionDoc.userId || ""),
          clientcode: sessionDoc.clientcode,
        });
        return loginResult;
      }

      recoveryCooldownUntil.set(sessionKey, Date.now() + RECOVERY_COOLDOWN_MS);
      return loginResult;
    } catch (error: any) {
      recoveryCooldownUntil.set(sessionKey, Date.now() + RECOVERY_COOLDOWN_MS);
      return {
        ok: false,
        reason: error?.message || "SESSION_RECOVERY_FAILED",
      };
    } finally {
      inFlightRecoveries.delete(sessionKey);
    }
  })();

  inFlightRecoveries.set(sessionKey, recoveryPromise);
  return recoveryPromise;
}

export function extractJwtFromSessionRecord(sessionDoc: any): string {
  if (!sessionDoc?.jwtToken) return "";
  return decrypt(sessionDoc.jwtToken, "session_record_jwt");
}
