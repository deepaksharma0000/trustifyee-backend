import AngelTokensModel from "../models/AngelTokens";
import log from "../utils/logger";

type SessionLookupInput = {
  userId?: string;
  clientcode?: string;
  purpose: string;
  allowGlobalFallback?: boolean;
  requireJwt?: boolean;
  strictIdentity?: boolean;
};

type CachedSession = {
  expiresAt: number;
  doc: any;
};

const SESSION_CACHE_TTL_MS = 10_000;
const sessionCache = new Map<string, CachedSession>();
const GLOBAL_FALLBACK_ENABLED = process.env.ALLOW_GLOBAL_SESSION_FALLBACK === "true";
const fallbackWarnedPurposes = new Set<string>();

const normalize = (value?: string) => (value || "").toString().trim();

const cacheKeyFor = (input: SessionLookupInput) => {
  const userId = normalize(input.userId);
  const clientcode = normalize(input.clientcode);
  const requireJwt = input.requireJwt !== false;
  const fallback = Boolean(input.allowGlobalFallback);
  const strict = input.strictIdentity !== false;
  return `${userId}|${clientcode}|${requireJwt ? "JWT" : "ANY"}|${fallback ? "GF" : "NGF"}|${strict ? "STRICT" : "FLEX"}`;
};

const isFresh = (entry?: CachedSession) => Boolean(entry && entry.expiresAt > Date.now());

const withJwtFilter = (query: any, requireJwt: boolean) => {
  if (!requireJwt) return query;
  return {
    ...query,
    jwtToken: { $exists: true, $ne: "" },
  };
};

export function invalidateAngelSessionCache(userId?: string, clientcode?: string) {
  const user = normalize(userId);
  const client = normalize(clientcode);
  const keys = Array.from(sessionCache.keys());

  for (const key of keys) {
    const [cachedUser, cachedClient] = key.split("|");
    if (user && cachedUser !== user) continue;
    if (client && cachedClient !== client) continue;
    sessionCache.delete(key);
  }
}

export function primeAngelSessionCache(sessionDoc: any) {
  if (!sessionDoc?.userId || !sessionDoc?.clientcode) return;
  const baseInput = {
    userId: String(sessionDoc.userId),
    clientcode: String(sessionDoc.clientcode),
    purpose: "cache_prime",
  };

  const entries = [
    cacheKeyFor({ ...baseInput, requireJwt: true, allowGlobalFallback: false }),
    cacheKeyFor({ ...baseInput, requireJwt: true, allowGlobalFallback: true }),
    cacheKeyFor({ ...baseInput, requireJwt: false, allowGlobalFallback: false }),
    cacheKeyFor({ ...baseInput, requireJwt: false, allowGlobalFallback: true }),
  ];

  const cached: CachedSession = {
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
    doc: sessionDoc,
  };

  entries.forEach((key) => sessionCache.set(key, cached));
}

/**
 * Strict session lookup for order execution — never falls back to clientcode-only
 * or global/admin sessions. Prevents admin session leakage into user trades.
 */
export async function resolveAngelSessionForExecution(input: {
  userId: string;
  clientcode: string;
  purpose: string;
}): Promise<any | null> {
  const userId = normalize(input.userId);
  const clientcode = normalize(input.clientcode);

  if (!userId) {
    log.error("[SESSION_CONTEXT] Execution lookup rejected: missing userId", {
      purpose: input.purpose,
    });
    return null;
  }

  if (!clientcode) {
    log.error("[SESSION_CONTEXT] Execution lookup rejected: missing clientcode", {
      purpose: input.purpose,
      userId,
    });
    return null;
  }

  return resolveAngelSessionContext({
    userId,
    clientcode,
    purpose: input.purpose,
    allowGlobalFallback: false,
    strictIdentity: true,
    requireJwt: true,
  });
}

export async function resolveAngelSessionContext(input: SessionLookupInput): Promise<any | null> {
  const lookup: SessionLookupInput = {
    ...input,
    requireJwt: input.requireJwt !== false,
  };

  const key = cacheKeyFor(lookup);
  const cached = sessionCache.get(key);
  if (isFresh(cached)) {
    return cached!.doc;
  }

  const userId = normalize(lookup.userId);
  const clientcode = normalize(lookup.clientcode);
  const requireJwt = lookup.requireJwt !== false;
  const requestedGlobalFallback = Boolean(lookup.allowGlobalFallback);
  const allowGlobalFallback = requestedGlobalFallback && GLOBAL_FALLBACK_ENABLED;
  const strictIdentity = lookup.strictIdentity !== false;

  let session: any = null;

  if (userId && clientcode) {
    session = await AngelTokensModel.findOne(withJwtFilter({ userId, clientcode }, requireJwt))
      .sort({ updatedAt: -1 })
      .lean();
    if (strictIdentity && !session) {
      return null;
    }
  }

  if (!session && userId) {
    session = await AngelTokensModel.findOne(withJwtFilter({ userId }, requireJwt))
      .sort({ updatedAt: -1 })
      .lean();
    if (strictIdentity && !session) {
      return null;
    }
  }

  const isExecutionPurpose = /order|execution|trade|place/i.test(String(lookup.purpose || ""));
  if (!session && clientcode && !isExecutionPurpose) {
    session = await AngelTokensModel.findOne(withJwtFilter({ clientcode }, requireJwt))
      .sort({ updatedAt: -1 })
      .lean();
    if (strictIdentity && !session) {
      return null;
    }
  }

  if (!session && requestedGlobalFallback && !GLOBAL_FALLBACK_ENABLED) {
    const key = `${lookup.purpose || "unknown"}:${userId}:${clientcode}`;
    if (!fallbackWarnedPurposes.has(key)) {
      fallbackWarnedPurposes.add(key);
      log.warn("[SESSION_CONTEXT] Global fallback is disabled by env. Returning no session.", {
        purpose: lookup.purpose,
        requestedUserId: userId || undefined,
        requestedClientcode: clientcode || undefined,
      });
    }
  }

  if (!session && allowGlobalFallback) {
    session = await AngelTokensModel.findOne(withJwtFilter({}, requireJwt))
      .sort({ updatedAt: -1 })
      .lean();

    if (session) {
      log.warn("[SESSION_CONTEXT] Using global fallback session", {
        purpose: lookup.purpose,
        requestedUserId: userId || undefined,
        requestedClientcode: clientcode || undefined,
        resolvedUserId: String(session.userId || ""),
        resolvedClientcode: session.clientcode,
      });
    }
  }

  if (!session) {
    return null;
  }

  sessionCache.set(key, {
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
    doc: session,
  });

  return session;
}
