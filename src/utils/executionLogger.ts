import log from "./logger";
import { apiKeyFingerprint } from "./apiKeyRouteBinding";

export type ExecutionLogContext = {
  userId: string;
  clientCode: string;
  purpose: string;
  correlationId?: string;
  clientOrderId?: string;
  signalId?: string;
  queueJobId?: string;
};

export type TokenAuditFields = {
  jwtLast8?: string;
  refreshPresent: boolean;
  feedPresent: boolean;
  apiKeyFingerprint: string;
  apiKeyLast4: string;
  tokenOwnerUserId: string;
  sessionClientCode: string;
};

export function maskToken(token?: string): string {
  const t = String(token || "").trim();
  if (!t) return "MISSING";
  if (t.length <= 8) return "***";
  return `***${t.slice(-8)}`;
}

export function buildTokenAudit(
  session: {
    userId: string;
    clientcode: string;
    jwtToken?: string;
    refreshToken?: string;
    feedToken?: string;
    apiKey: string;
  }
): TokenAuditFields {
  const apiKey = String(session.apiKey || "");
  return {
    jwtLast8: maskToken(session.jwtToken),
    refreshPresent: Boolean(session.refreshToken),
    feedPresent: Boolean(session.feedToken),
    apiKeyFingerprint: apiKeyFingerprint(apiKey),
    apiKeyLast4: apiKey.length >= 4 ? apiKey.slice(-4) : "N/A",
    tokenOwnerUserId: String(session.userId),
    sessionClientCode: String(session.clientcode),
  };
}

export function logExecutionContext(
  ctx: ExecutionLogContext,
  event: string,
  extra?: Record<string, unknown>
) {
  log.info(`[EXECUTION] ${event}`, {
    ...ctx,
    ...extra,
    timestamp: new Date().toISOString(),
  });
}

export function logOrderPayload(
  ctx: ExecutionLogContext,
  payload: Record<string, unknown>,
  tokenAudit: TokenAuditFields
) {
  log.info("[EXECUTION] ORDER_PAYLOAD", {
    ...ctx,
    ...tokenAudit,
    payload,
  });
}

export function logAngelResponse(
  ctx: ExecutionLogContext,
  response: unknown,
  tokenAudit: TokenAuditFields
) {
  log.info("[EXECUTION] ANGEL_RESPONSE", {
    ...ctx,
    ...tokenAudit,
    response,
  });
}

export function logExecutionError(
  ctx: ExecutionLogContext,
  error: unknown,
  tokenAudit?: TokenAuditFields
) {
  const message = error instanceof Error ? error.message : String(error);
  log.error("[EXECUTION] FAILED", {
    ...ctx,
    ...(tokenAudit || {}),
    error: message,
    stack: error instanceof Error ? error.stack : undefined,
  });
}
