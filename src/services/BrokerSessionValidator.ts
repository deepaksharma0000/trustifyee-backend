import { config } from "../config";
import { apiKeyFingerprint } from "../utils/apiKeyRouteBinding";
import { decrypt, ensureEncrypted, isMigrated } from "../utils/encryption";
import { parseAngelResponse } from "../utils/angelResponseParser";
import { StartupDiagnostics } from "../utils/startupDiagnostics";
import log from "../utils/logger";

export type BrokerExecutionContext = {
  userId: string;
  clientCode: string;
  broker: string;
  purpose: string;
  apiKeyLast4: string;
  apiKeyFingerprint: string;
  apiKeySource: "TOKEN" | "PROFILE" | "NONE";
  requestIp: string;
  routeType: string;
  tokenOwner: string;
  executionMode: string;
  jwtClientCode?: string;
  sessionConsistent: boolean;
};

export type ResolvedApiKeyPair = {
  apiKey: string;
  source: "TOKEN" | "PROFILE";
  synced: boolean;
  mismatchDetected: boolean;
};

const ANGEL_API_KEY_MIN = 6;
const ANGEL_API_KEY_MAX = 64;

export function isAngelApiKeyError(errorOrResponse: any): boolean {
  const parsed = parseAngelResponse(errorOrResponse?.response?.data || errorOrResponse?.data || errorOrResponse);
  const code = parsed.errorCode.toUpperCase();
  const msg = String(parsed.brokerMessage || parsed.rejectionReason || "").toLowerCase();
  return code === "AG8004" || msg.includes("invalid api key");
}

export function isAngelIpWhitelistError(errorOrResponse: any): boolean {
  const parsed = parseAngelResponse(errorOrResponse?.response?.data || errorOrResponse?.data || errorOrResponse);
  const msg = String(parsed.brokerMessage || parsed.rejectionReason || "").toLowerCase();
  return (
    msg.includes("unregistered ip") ||
    msg.includes("register your ip") ||
    msg.includes("static ip") ||
    msg.includes("access denied")
  );
}

export function validateApiKeyFormat(apiKey?: string): { valid: boolean; reason?: string } {
  const key = String(apiKey || "").trim();
  if (!key) return { valid: false, reason: "API_KEY_MISSING" };
  if (isMigrated(key)) return { valid: false, reason: "API_KEY_STILL_ENCRYPTED" };
  if (key.length < ANGEL_API_KEY_MIN || key.length > ANGEL_API_KEY_MAX) {
    return { valid: false, reason: `API_KEY_LENGTH_INVALID:${key.length}` };
  }
  if (key.startsWith("enc::")) return { valid: false, reason: "API_KEY_ENCRYPTED_BLOB" };
  return { valid: true };
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const token = String(jwt || "").trim();
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function extractClientCodeFromJwt(jwt: string): string {
  const payload = decodeJwtPayload(jwt);
  if (!payload) return "";
  const candidates = [
    payload.loginId,
    payload.clientcode,
    payload.clientCode,
    payload.sub,
    payload.user,
    payload.userId,
  ];
  for (const value of candidates) {
    const normalized = String(value || "").trim().toUpperCase();
    if (normalized) return normalized;
  }
  return "";
}

export async function resolveConsistentApiKey(input: {
  angelTokens: any;
  profile?: any;
  userId: string;
  clientcode: string;
}): Promise<ResolvedApiKeyPair> {
  const { angelTokens, profile, userId, clientcode } = input;

  const tokenApiKey = angelTokens?.apiKey
    ? await ensureEncrypted(angelTokens, "apiKey", `user_${userId}_session_api_${clientcode}`)
    : "";
  const profileApiKey = profile?.api_key
    ? await ensureEncrypted(profile, "api_key", `user_${userId}_profile_api_${clientcode}`)
    : "";

  if (!tokenApiKey && !profileApiKey) {
    return { apiKey: "", source: "TOKEN", synced: false, mismatchDetected: false };
  }

  if (!tokenApiKey && profileApiKey) {
    return { apiKey: profileApiKey, source: "PROFILE", synced: false, mismatchDetected: false };
  }

  if (tokenApiKey && !profileApiKey) {
    return { apiKey: tokenApiKey, source: "TOKEN", synced: false, mismatchDetected: false };
  }

  if (tokenApiKey === profileApiKey) {
    return { apiKey: tokenApiKey, source: "TOKEN", synced: false, mismatchDetected: false };
  }

  log.error("[BROKER_API_KEY_MISMATCH] AngelTokens.apiKey !== User.api_key — reject execution.", {
    clientcode,
    tokenApiKey: apiKeyFingerprint(tokenApiKey),
    profileApiKey: apiKeyFingerprint(profileApiKey),
  });

  return {
    apiKey: tokenApiKey,
    source: "TOKEN",
    synced: false,
    mismatchDetected: true,
  };
}

/**
 * Validates AngelTokens document belongs to the order user and matches profile client + api key.
 */
export async function assertAngelTokenOwnership(input: {
  orderUserId: string;
  clientcode: string;
  angelTokens: any;
  profile?: any;
}): Promise<void> {
  const { orderUserId, clientcode, angelTokens, profile } = input;

  const tokenUserId = String(angelTokens?.userId || "").trim();
  if (!tokenUserId || tokenUserId !== String(orderUserId).trim()) {
    throw new Error(
      `TOKEN_OWNERSHIP_VIOLATION: AngelTokens.userId (${tokenUserId || "MISSING"}) !== order.userId (${orderUserId})`
    );
  }

  const tokenClient = String(angelTokens?.clientcode || "").trim().toUpperCase();
  const expectedClient = String(clientcode || "").trim().toUpperCase();
  if (!tokenClient || tokenClient !== expectedClient) {
    throw new Error(
      `TOKEN_OWNERSHIP_VIOLATION: AngelTokens.clientcode (${tokenClient || "MISSING"}) !== broker.clientCode (${expectedClient})`
    );
  }

  if (profile?.client_key) {
    const profileClient = (await ensureEncrypted(profile, "client_key", `ownership_${orderUserId}`))
      .trim()
      .toUpperCase();
    if (profileClient && profileClient !== expectedClient) {
      throw new Error(
        `TOKEN_OWNERSHIP_VIOLATION: User.client_key (${profileClient}) !== order clientCode (${expectedClient})`
      );
    }
  }

  const tokenApiKey = angelTokens?.apiKey
    ? await ensureEncrypted(angelTokens, "apiKey", `ownership_api_${orderUserId}_${clientcode}`)
    : "";
  const profileApiKey = profile?.api_key
    ? await ensureEncrypted(profile, "api_key", `ownership_profile_${orderUserId}_${clientcode}`)
    : "";

  if (tokenApiKey && profileApiKey && tokenApiKey !== profileApiKey) {
    throw new Error(
      "TOKEN_OWNERSHIP_VIOLATION: AngelTokens.apiKey !== User.api_key. Reconnect broker from Profile."
    );
  }

  if (!tokenApiKey && !profileApiKey) {
    throw new Error(
      "TOKEN_OWNERSHIP_VIOLATION: No SmartAPI Private Key on session or profile. Reconnect broker."
    );
  }
}

export function assertJwtMatchesClientCode(jwtToken: string, expectedClientCode: string): void {
  const jwtClient = extractClientCodeFromJwt(jwtToken);
  const expected = String(expectedClientCode || "").trim().toUpperCase();
  if (!jwtClient || !expected) return;
  if (jwtClient !== expected) {
    throw new Error(
      `BROKER_SESSION_CLIENT_MISMATCH: JWT client (${jwtClient}) does not match profile client (${expected}). Reconnect broker.`
    );
  }
}

export function assertApiKeyJwtPair(apiKey: string, jwtToken: string, clientcode: string): void {
  const keyCheck = validateApiKeyFormat(apiKey);
  if (!keyCheck.valid) {
    throw new Error(`BROKER_SESSION_INVALID_API_KEY: ${keyCheck.reason || "invalid"}`);
  }
  if (!jwtToken || jwtToken.length < 20) {
    throw new Error("BROKER_SESSION_INVALID_JWT: Session token missing or too short.");
  }
  assertJwtMatchesClientCode(jwtToken, clientcode);
}

export function logBrokerExecutionContext(ctx: BrokerExecutionContext): void {
  const enhancedCtx = {
    ...ctx,
    AssignedExecutionIp: ctx.requestIp,
    LocalAddress: ctx.requestIp,
    SocketLocalAddress: ctx.requestIp,
    RemoteAddress: "apiconnect.angelone.in",
    AxiosAgent: ctx.routeType === "AGENT_ROUTE" ? "ProxyAgent" : "LocalBindAgent",
    RouteType: ctx.routeType,
    ProxyUsed: ctx.routeType === "AGENT_ROUTE" ? "Yes" : "No",
    InterfaceUsed: ctx.routeType === "AGENT_ROUTE" ? "agent_tunnel" : "eth0_alias",
    OutgoingIP: ctx.requestIp,
    TokenOwner: ctx.tokenOwner,
    ClientCode: ctx.clientCode,
    APIKeyFingerprint: ctx.apiKeyFingerprint,
  };
  log.info("BROKER_EXECUTION_CONTEXT", enhancedCtx);
}

export function buildIpWhitelistDiagnostics(input?: {
  dedicatedIpEnabled?: boolean;
  userOutgoingIp?: string;
}) {
  const detectedOutboundIp = StartupDiagnostics.detectedOutboundIp || "UNKNOWN";
  const configuredPublicIp = config.publicIp || "UNKNOWN";
  const serverIpMatch = StartupDiagnostics.whitelistMatch;
  const headerIp = configuredPublicIp;

  return {
    detectedOutboundIp,
    configuredPublicIp,
    serverConfigMatch: serverIpMatch,
    serverConfigMismatch: StartupDiagnostics.whitelistMismatchExists,
    angelHeaderPublicIp: headerIp,
    dedicatedIpEnabled: Boolean(input?.dedicatedIpEnabled),
    userOutgoingIp: input?.userOutgoingIp || null,
    explanation:
      "Each user must register their own SmartAPI app and whitelist PUBLIC_IP on the Angel One developer portal.",
    perUserPortalActionRequired: true,
  };
}

export function auditBrokerAuthFailure(input: {
  userId: string;
  clientcode: string;
  purpose: string;
  response: any;
  apiKeyFingerprint: string;
  requestIp: string;
}) {
  const parsed = parseAngelResponse(input.response?.response?.data || input.response?.data || input.response);
  log.warn("BROKER_AUTH_FAILURE_AUDIT", {
    userId: input.userId,
    clientcode: input.clientcode,
    purpose: input.purpose,
    errorCode: parsed.errorCode,
    message: parsed.brokerMessage,
    apiKeyFingerprint: input.apiKeyFingerprint,
    requestIp: input.requestIp,
    isInvalidApiKey: isAngelApiKeyError(input.response),
    isIpWhitelist: isAngelIpWhitelistError(input.response),
    ipDiagnostics: buildIpWhitelistDiagnostics(),
  });
}
