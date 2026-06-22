import { getOrCreateUserAngelAdapter } from "./AngelAdapterRegistry";
import { resolveAngelSessionForExecution } from "./AngelSessionContextService";
import { recoverSessionByRefreshOrLogin } from "./AngelSessionLifecycleService";
import { ensureEncrypted } from "../utils/encryption";
import {
  assertApiKeyJwtPair,
  auditBrokerAuthFailure,
  extractClientCodeFromJwt,
  isAngelApiKeyError,
  logBrokerExecutionContext,
  resolveConsistentApiKey,
  assertAngelTokenOwnership,
} from "./BrokerSessionValidator";
import { apiKeyFingerprint, resolveRouteBinding } from "../utils/apiKeyRouteBinding";
import { getAngelNetworkIdentity } from "../utils/angelNetworkIdentity";
import { config } from "../config";
import { parseAngelResponse } from "../utils/angelResponseParser";
import { buildTokenAudit, logExecutionContext, type ExecutionLogContext } from "../utils/executionLogger";
import log from "../utils/logger";
import User from "../models/User";
import Admin from "../models/Admin";
import AngelTokensModel from "../models/AngelTokens";

export type IsolatedAngelSession = {
  userId: string;
  clientcode: string;
  jwtToken: string;
  refreshToken: string;
  feedToken: string;
  apiKey: string;
  sessionDoc: any;
  adapter: ReturnType<typeof getOrCreateUserAngelAdapter>;
};

type SessionInput = {
  userId: string;
  clientcode: string;
  purpose: string;
  outgoingIp?: string;
  agentUrl?: string;
  forceRefresh?: boolean;
  correlationId?: string;
  clientOrderId?: string;
};

const PROACTIVE_REFRESH_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.ANGEL_PROACTIVE_REFRESH_MS || "1800000")
);

function extractClientCodeFromJwtSafe(jwt: string) {
  try {
    return extractClientCodeFromJwt(jwt);
  } catch {
    return "";
  }
}

function getBrokerErrorPayload(errorOrResponse: any) {
  return errorOrResponse?.response?.data || errorOrResponse?.data || errorOrResponse || {};
}

export function isAngelInvalidToken(errorOrResponse: any): boolean {
  const parsed = parseAngelResponse(getBrokerErrorPayload(errorOrResponse));
  const msg = String(parsed.brokerMessage || parsed.rejectionReason || "").toLowerCase();
  const code = parsed.errorCode.toUpperCase();
  return (
    code === "AG8001" ||
    code === "AB1010" ||
    msg.includes("invalid token") ||
    msg.includes("invalid session") ||
    msg.includes("session expired") ||
    msg.includes("token expired") ||
    msg.includes("expired") ||
    isAngelApiKeyError(errorOrResponse)
  );
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

async function loadProfile(userId: string): Promise<{ type: "user" | "admin"; profile: any } | null> {
  const user = await User.findById(userId)
    .select("+client_key +broker_password +broker_totp_secret +api_key +outgoing_ip +agent_url dedicated_ip_enabled")
    .lean();
  if (user) return { type: "user", profile: user };

  const admin = await Admin.findById(userId)
    .select("+client_key +panel_client_key +broker_password +broker_totp_secret +api_key +outgoing_ip +agent_url")
    .lean();
  if (admin) return { type: "admin", profile: admin };

  return null;
}

async function resolveApiKey(session: any, userId: string, purpose: string) {
  const loaded = await loadProfile(userId);
  const profile = loaded?.profile;
  const resolved = await resolveConsistentApiKey({
    angelTokens: session,
    profile,
    userId,
    clientcode: String(session?.clientcode || ""),
  });

  return {
    apiKey: resolved.apiKey,
    source: resolved.source,
    mismatchDetected: resolved.mismatchDetected,
    profile,
    loaded,
  };
}

function assertNoAdminSessionLeak(input: SessionInput, session: any) {
  const sessionUserId = String(session?.userId || "");
  if (sessionUserId && sessionUserId !== String(input.userId)) {
    throw new Error(
      `BROKER_SESSION_USER_MISMATCH: requested userId=${input.userId} but token belongs to userId=${sessionUserId}`
    );
  }
  const sessionClient = String(session?.clientcode || "").trim();
  const requestedClient = String(input.clientcode || "").trim();
  if (requestedClient && sessionClient && sessionClient !== requestedClient) {
    throw new Error(
      `BROKER_SESSION_CLIENT_MISMATCH: requested clientcode=${requestedClient} but token clientcode=${sessionClient}`
    );
  }
}

/**
 * Resolves and validates an isolated Angel session for a single user.
 * Never uses global/admin session fallback.
 */
export async function getIsolatedAngelSession(input: SessionInput): Promise<IsolatedAngelSession> {
  const execCtx: ExecutionLogContext = {
    userId: input.userId,
    clientCode: input.clientcode,
    purpose: input.purpose,
    correlationId: input.correlationId,
    clientOrderId: input.clientOrderId,
  };

  logExecutionContext(execCtx, "SESSION_RESOLVE_START");

  let session = await resolveAngelSessionForExecution({
    userId: input.userId,
    clientcode: input.clientcode,
    purpose: input.purpose,
  });

  if (!session) {
    throw new Error("ANGEL_SESSION_MISSING: User must connect broker before trading.");
  }

  assertNoAdminSessionLeak(input, session);

  if (shouldRefresh(session, input.forceRefresh)) {
    log.warn("ANGEL_TOKEN_EXPIRED", {
      ...execCtx,
      broker: "ANGELONE",
      proactive: !input.forceRefresh,
    });

    const recovered = await recoverSessionByRefreshOrLogin(session, input.purpose);
    if (!recovered.ok) {
      throw new Error(`ANGEL_SESSION_REFRESH_FAILED: ${recovered.reason || "unknown"}`);
    }

    session = await AngelTokensModel.findById(session._id).lean();
    if (!session) {
      throw new Error("ANGEL_SESSION_REFRESH_FAILED: session document missing after recovery");
    }
    assertNoAdminSessionLeak(input, session);
  }

  const userId = String(session.userId || input.userId);
  const clientcode = String(session.clientcode || input.clientcode).trim();
  let jwtToken = session.jwtToken
    ? await ensureEncrypted(session, "jwtToken", `${input.purpose}_jwt_${clientcode}`)
    : "";
  let feedToken = session.feedToken
    ? await ensureEncrypted(session, "feedToken", `${input.purpose}_feed_${clientcode}`)
    : "";
  let refreshToken = session.refreshToken
    ? await ensureEncrypted(session, "refreshToken", `${input.purpose}_refresh_${clientcode}`)
    : "";

  let keyResolution = await resolveApiKey(session, userId, input.purpose);
  let apiKey = keyResolution.apiKey;
  const profile = keyResolution.profile;

  await assertAngelTokenOwnership({
    orderUserId: userId,
    clientcode,
    angelTokens: session,
    profile,
  });

  if (keyResolution.mismatchDetected) {
    throw new Error(
      "BROKER_API_KEY_TOKEN_MISMATCH: User api_key does not match AngelTokens.api_key. Reconnect broker from Profile."
    );
  }

  if (!clientcode || !jwtToken || !apiKey) {
    throw new Error("ANGEL_SESSION_INVALID: clientcode, jwtToken, or apiKey missing after validation.");
  }

  assertApiKeyJwtPair(apiKey, jwtToken, clientcode);

  const jwtClientCode = extractClientCodeFromJwtSafe(jwtToken);
  if (jwtClientCode && jwtClientCode !== clientcode) {
    throw new Error(
      `BROKER_SESSION_CLIENT_MISMATCH: JWT client ${jwtClientCode} does not match ${clientcode}`
    );
  }

  const dedicatedIpEnabled = Boolean(profile?.dedicated_ip_enabled === true);
  const routeBinding = resolveRouteBinding({
    outgoingIp: profile?.outgoing_ip,
    agentUrl: profile?.agent_url,
    dedicatedIpEnabled,
  });
  const adapterOutgoingIp =
    input.outgoingIp ||
    (dedicatedIpEnabled ? routeBinding.routeIp || undefined : routeBinding.routeIp || config.publicIp || undefined);
  const adapterAgentUrl = input.agentUrl || (dedicatedIpEnabled ? routeBinding.agentUrl || undefined : undefined);

  const identity = getAngelNetworkIdentity();
  const requestIp = adapterOutgoingIp || identity.publicIp || config.publicIp || "UNKNOWN";

  logBrokerExecutionContext({
    userId,
    clientCode: clientcode,
    broker: "ANGELONE",
    purpose: input.purpose,
    apiKeyLast4: apiKey.slice(-4),
    apiKeyFingerprint: apiKeyFingerprint(apiKey),
    apiKeySource: keyResolution.source === "PROFILE" ? "PROFILE" : "TOKEN",
    requestIp,
    routeType: adapterAgentUrl ? "AGENT_ROUTE" : dedicatedIpEnabled ? "DEDICATED" : "SERVER_SHARED_IP",
    tokenOwner: userId,
    executionMode: process.env.EXECUTION_MODE || "SERVER_SHARED_IP",
    jwtClientCode,
    sessionConsistent: true,
  });

  const adapter = getOrCreateUserAngelAdapter(userId, apiKey, {
    outgoingIp: adapterOutgoingIp,
    agentUrl: adapterAgentUrl,
  });

  const isolated: IsolatedAngelSession = {
    userId,
    clientcode,
    jwtToken,
    feedToken,
    refreshToken,
    apiKey,
    sessionDoc: session,
    adapter,
  };

  logExecutionContext(execCtx, "SESSION_RESOLVE_OK", buildTokenAudit(isolated));

  return isolated;
}

/**
 * Executes a broker operation with automatic token refresh on AG8001/AG8004.
 */
export async function executeWithIsolatedSession<T>(
  input: SessionInput,
  fn: (session: IsolatedAngelSession) => Promise<T>
): Promise<T> {
  const session = await getIsolatedAngelSession(input);

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

    const refreshed = await getIsolatedAngelSession({ ...input, forceRefresh: true });
    return fn(refreshed);
  }
}
