import User from "../models/User";
import Admin from "../models/Admin";
import AngelTokensModel from "../models/AngelTokens";
import { getOrCreateAngelAdapter } from "./AngelAdapterRegistry";
import { resolveAngelSessionContext } from "./AngelSessionContextService";
import { recoverSessionByRefreshOrLogin } from "./AngelSessionLifecycleService";
import { decrypt, ensureEncrypted } from "../utils/encryption";
import { parseAngelResponse } from "../utils/angelResponseParser";
import { getAngelNetworkIdentity } from "../utils/angelNetworkIdentity";
import {
  assertApiKeyJwtPair,
  auditBrokerAuthFailure,
  isAngelApiKeyError,
  logBrokerExecutionContext,
  resolveConsistentApiKey,
} from "./BrokerSessionValidator";
import { apiKeyFingerprint } from "../utils/apiKeyRouteBinding";
import { config } from "../config";
import { extractClientCodeFromJwt } from "./BrokerSessionValidator";
import log from "../utils/logger";

function extractClientCodeFromJwtSafe(jwt: string) {
  try {
    return extractClientCodeFromJwt(jwt);
  } catch {
    return "";
  }
}

type EnsureSessionInput = {
  userId?: string;
  clientcode?: string;
  purpose: string;
  outgoingIp?: string;
  agentUrl?: string;
  forceRefresh?: boolean;
  allowGlobalFallback?: boolean;
};

export type ValidAngelSession = {
  userId: string;
  clientcode: string;
  jwtToken: string;
  feedToken: string;
  refreshToken: string;
  apiKey: string;
  sessionDoc: any;
  adapter: ReturnType<typeof getOrCreateAngelAdapter>;
};

const PROACTIVE_REFRESH_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.ANGEL_PROACTIVE_REFRESH_MS || "1800000")
);

const profileCache = new Map<string, { expiresAt: number; profile: any }>();
const PROFILE_CACHE_MS = 30_000;

function getBrokerErrorPayload(errorOrResponse: any) {
  return errorOrResponse?.response?.data || errorOrResponse?.data || errorOrResponse || {};
}

export function isAngelInvalidToken(errorOrResponse: any): boolean {
  const parsed = parseAngelResponse(getBrokerErrorPayload(errorOrResponse));
  const msg = String(parsed.brokerMessage || parsed.rejectionReason || "").toLowerCase();
  return (
    parsed.errorCode.toUpperCase() === "AG8001" ||
    msg.includes("invalid token") ||
    isAngelApiKeyError(errorOrResponse)
  );
}

async function loadProfile(userId: string) {
  const cached = profileCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.profile;

  const user = await User.findById(userId)
    .select("+client_key +broker_password +broker_totp_secret +api_key +outgoing_ip +agent_url dedicated_ip_enabled")
    .lean();
  const profile =
    user ||
    (await Admin.findById(userId)
      .select("+client_key +panel_client_key +broker_password +broker_totp_secret +api_key +outgoing_ip +agent_url")
      .lean());

  profileCache.set(userId, { expiresAt: Date.now() + PROFILE_CACHE_MS, profile });
  return profile;
}

async function resolveApiKey(session: any, userId: string, purpose: string) {
  if (!userId) {
    const fromSession = session?.apiKey
      ? await ensureEncrypted(session, "apiKey", `${purpose}_session_api_${session?.clientcode || "UNKNOWN"}`)
      : "";
    return fromSession;
  }

  const profile = await loadProfile(userId);
  const resolved = await resolveConsistentApiKey({
    angelTokens: session,
    profile,
    userId,
    clientcode: String(session?.clientcode || ""),
  });
  return resolved.apiKey;
}

function shouldRefresh(session: any, forceRefresh?: boolean) {
  if (forceRefresh) return true;
  if (!session?.jwtToken) return true;
  const expiresAt = session?.expiresAt ? new Date(session.expiresAt).getTime() : 0;
  if (!expiresAt) {
    const updatedAt = session?.updatedAt ? new Date(session.updatedAt).getTime() : 0;
    return Boolean(updatedAt && Date.now() - updatedAt > 18 * 60 * 60 * 1000);
  }
  return expiresAt - Date.now() <= PROACTIVE_REFRESH_MS;
}

export async function ensureValidSession(input: EnsureSessionInput): Promise<ValidAngelSession> {
  let session = await resolveAngelSessionContext({
    userId: input.userId,
    clientcode: input.clientcode,
    purpose: input.purpose,
    allowGlobalFallback: Boolean(input.allowGlobalFallback),
    strictIdentity: true,
    requireJwt: true,
  });

  if (!session) {
    session = await AngelTokensModel.findOne({
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.clientcode ? { clientcode: input.clientcode } : {}),
    }).sort({ updatedAt: -1 });
  }

  if (!session) {
    throw new Error("ANGEL_SESSION_MISSING: User must connect broker before trading.");
  }

  if (shouldRefresh(session, input.forceRefresh)) {
    log.warn("ANGEL_TOKEN_EXPIRED", {
      clientCode: session.clientcode || input.clientcode,
      broker: "ANGELONE",
      purpose: input.purpose,
      proactive: !input.forceRefresh,
    });

    const recovered = await recoverSessionByRefreshOrLogin(session, input.purpose);
    if (!recovered.ok) {
      throw new Error(`ANGEL_SESSION_REFRESH_FAILED: ${recovered.reason || "unknown"}`);
    }

    log.info("ANGEL_SESSION_REFRESH_SUCCESS", {
      clientCode: session.clientcode || input.clientcode,
      mode: recovered.mode,
      purpose: input.purpose,
    });

    session = await AngelTokensModel.findById(session._id).lean();
  }

  const userId = String(session?.userId || input.userId || "");
  const clientcode = String(session?.clientcode || input.clientcode || "").trim();
  const jwtToken = session?.jwtToken
    ? await ensureEncrypted(session, "jwtToken", `${input.purpose}_jwt_${clientcode}`)
    : "";
  const feedToken = session?.feedToken
    ? await ensureEncrypted(session, "feedToken", `${input.purpose}_feed_${clientcode}`)
    : "";
  const refreshToken = session?.refreshToken
    ? await ensureEncrypted(session, "refreshToken", `${input.purpose}_refresh_${clientcode}`)
    : "";
  const apiKey = await resolveApiKey(session, userId, input.purpose);

  if (!clientcode || !jwtToken || !apiKey) {
    throw new Error("ANGEL_SESSION_INVALID: clientcode, jwtToken, or apiKey missing after validation.");
  }

  assertApiKeyJwtPair(apiKey, jwtToken, clientcode);

  const identity = getAngelNetworkIdentity();
  const requestIp = input.outgoingIp || identity.publicIp || config.publicIp || "UNKNOWN";

  logBrokerExecutionContext({
    userId,
    clientCode: clientcode,
    broker: "ANGELONE",
    purpose: input.purpose,
    apiKeyLast4: apiKey.slice(-4),
    apiKeyFingerprint: apiKeyFingerprint(apiKey),
    apiKeySource: "TOKEN",
    requestIp,
    routeType: input.agentUrl ? "AGENT_ROUTE" : input.outgoingIp ? "DEDICATED" : "SERVER_SHARED_IP",
    tokenOwner: userId,
    executionMode: process.env.EXECUTION_MODE || "SERVER_SHARED_IP",
    jwtClientCode: extractClientCodeFromJwtSafe(jwtToken),
    sessionConsistent: true,
  });

  const adapter = getOrCreateAngelAdapter(apiKey, {
    outgoingIp: input.outgoingIp,
    agentUrl: input.agentUrl,
  });

  return {
    userId,
    clientcode,
    jwtToken,
    feedToken,
    refreshToken,
    apiKey,
    sessionDoc: session,
    adapter,
  };
}

export async function executeWithSessionRecovery<T>(
  input: EnsureSessionInput,
  fn: (session: ValidAngelSession) => Promise<T>
): Promise<T> {
  const session = await ensureValidSession(input);
  try {
    const response = await fn(session);
    if (isAngelInvalidToken(response)) {
      auditBrokerAuthFailure({
        userId: session.userId,
        clientcode: session.clientcode,
        purpose: input.purpose,
        response,
        apiKeyFingerprint: apiKeyFingerprint(session.apiKey),
        requestIp: input.outgoingIp || config.publicIp || "UNKNOWN",
      });
      const errCode = isAngelApiKeyError(response) ? "AG8004 Invalid API Key" : "AG8001 Invalid Token";
      throw Object.assign(new Error(errCode), { response: { data: getBrokerErrorPayload(response) } });
    }
    return response;
  } catch (error: any) {
    if (!isAngelInvalidToken(error)) throw error;

    auditBrokerAuthFailure({
      userId: session.userId,
      clientcode: session.clientcode,
      purpose: input.purpose,
      response: error,
      apiKeyFingerprint: apiKeyFingerprint(session.apiKey),
      requestIp: input.outgoingIp || config.publicIp || "UNKNOWN",
    });

    log.warn(isAngelApiKeyError(error) ? "ANGEL_API_KEY_MISMATCH" : "ANGEL_TOKEN_EXPIRED", {
      clientCode: session.clientcode,
      broker: "ANGELONE",
      purpose: input.purpose,
    });

    const refreshedSession = await ensureValidSession({
      ...input,
      forceRefresh: true,
    });

    log.info("ANGEL_SESSION_REFRESH_SUCCESS", {
      clientCode: refreshedSession.clientcode,
      purpose: input.purpose,
    });

    return fn(refreshedSession);
  }
}
