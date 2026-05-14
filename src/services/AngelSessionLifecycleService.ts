import AngelTokensModel from "../models/AngelTokens";
import User from "../models/User";
import Admin from "../models/Admin";
import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import { ensureEncrypted, encrypt, decrypt } from "../utils/encryption";
import log from "../utils/logger";
import { invalidateAngelSessionCache, primeAngelSessionCache } from "./AngelSessionContextService";
import { getOrCreateAngelAdapter } from "./AngelAdapterRegistry";

type RecoveryMode = "REFRESH" | "RELOGIN";

export type SessionRecoveryResult = {
  ok: boolean;
  mode?: RecoveryMode;
  jwtToken?: string;
  refreshToken?: string;
  feedToken?: string;
  reason?: string;
  errorCode?: string;
};

const inFlightRecoveries = new Map<string, Promise<SessionRecoveryResult>>();
const recoveryCooldownUntil = new Map<string, number>();
const RECOVERY_COOLDOWN_MS = 60_000;

const toSessionKey = (sessionDoc: any) =>
  String(sessionDoc?._id || `${sessionDoc?.userId || "UNKNOWN"}:${sessionDoc?.clientcode || "UNKNOWN"}`);

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

const persistRecoveredTokens = async (sessionDoc: any, tokens: { jwtToken: string; refreshToken?: string; feedToken?: string }) => {
  const updatedPayload = {
    jwtToken: encrypt(tokens.jwtToken),
    refreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : sessionDoc.refreshToken,
    feedToken: tokens.feedToken ? encrypt(tokens.feedToken) : sessionDoc.feedToken,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  };

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
    .select("+broker_password +broker_totp_secret +client_key +api_key +outgoing_ip +agent_url")
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

  const sessionApiKey = await ensureEncrypted(sessionDoc, "apiKey", `${context}_refresh_api_${sessionDoc.clientcode}`);
  const refreshToken = await ensureEncrypted(sessionDoc, "refreshToken", `${context}_refresh_rt_${sessionDoc.clientcode}`);

  if (!sessionApiKey || !refreshToken) {
    return { ok: false, reason: "REFRESH_MISSING_API_OR_TOKEN" };
  }

  const adapter = getOrCreateAngelAdapter(sessionApiKey);
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
    return { ok: false, reason: "MISSING_USER_ID_FOR_RELOGIN" };
  }

  const loaded = await getProfileWithSecrets(userId);
  if (!loaded?.profile) {
    return { ok: false, reason: "PROFILE_NOT_FOUND_FOR_RELOGIN" };
  }

  const profile: any = loaded.profile;

  const clientCode = sessionDoc.clientcode || decrypt(profile?.client_key || profile?.panel_client_key || "");
  const password = profile?.broker_password ? decrypt(profile.broker_password, `${context}_pwd`) : "";
  const totpSecret = profile?.broker_totp_secret ? decrypt(profile.broker_totp_secret, `${context}_totp`) : "";

  let apiKey = sessionDoc?.apiKey ? decrypt(sessionDoc.apiKey, `${context}_api_session`) : "";
  if (!apiKey && profile?.api_key) {
    apiKey = decrypt(profile.api_key, `${context}_api_profile`);
  }

  if (!clientCode || !password || !totpSecret || !apiKey) {
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
    };
  }

  const adapter = getOrCreateAngelAdapter(apiKey, {
    outgoingIp: profile?.outgoing_ip || undefined,
    agentUrl: profile?.agent_url || undefined,
  });
  const loginResponse = await adapter.generateSession({
    clientcode: clientCode,
    password,
    totp: "",
    totp_secret: totpSecret,
  });

  const parsed = extractTokenPayload(loginResponse);
  if (!parsed.ok || !parsed.jwtToken) {
    if (loaded.type === "user") {
      await User.updateOne(
        { _id: userId },
        { $set: { broker_connected: false } }
      );
    } else {
      await Admin.updateOne(
        { _id: userId },
        { $set: { broker_connected: false } }
      );
    }

    return {
      ok: false,
      reason: parsed.message || "RELOGIN_FAILED",
      errorCode: parsed.errorCode,
    };
  }

  await persistRecoveredTokens(sessionDoc, {
    jwtToken: parsed.jwtToken,
    refreshToken: parsed.refreshToken,
    feedToken: parsed.feedToken,
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
