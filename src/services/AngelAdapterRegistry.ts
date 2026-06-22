import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import { config } from "../config";
import log from "../utils/logger";

type AdapterEntry = {
  adapter: AngelOneAdapter;
  expiresAt: number;
  userId: string;
};

const ADAPTER_TTL_MS = 15 * 60 * 1000;
const MAX_ADAPTER_CACHE = 500;
const adapterCache = new Map<string, AdapterEntry>();

const normalize = (value?: string) => (value || "").toString().trim();

/**
 * MongoDB userId of the dedicated market-data account (from SYSTEM_DATA_SCOPE_USER_ID env).
 * Never used for user order placement.
 */
export function getSystemDataScopeUserId(): string {
  return String(config.systemDataScopeUserId || "").trim();
}

/** @deprecated Use getSystemDataScopeUserId() — reads SYSTEM_DATA_SCOPE_USER_ID from env. */
export const SYSTEM_DATA_SCOPE_USER_ID = getSystemDataScopeUserId;

export type UserAdapterOptions = {
  outgoingIp?: string;
  agentUrl?: string;
  isDataAccount?: boolean;
};

const buildCacheKey = (
  userId: string,
  apiKey: string,
  outgoingIp?: string,
  agentUrl?: string,
  isDataAccount = false
) =>
  [
    normalize(userId),
    normalize(apiKey).slice(-8),
    normalize(outgoingIp),
    normalize(agentUrl),
    isDataAccount ? "DATA" : "USER",
  ].join("|");

/**
 * Per-user isolated Angel adapter. Cache key includes userId so adapters
 * are never shared across users even when API keys collide.
 */
export function getOrCreateUserAngelAdapter(
  userId: string,
  apiKey: string,
  options?: UserAdapterOptions
): AngelOneAdapter {
  const scopeUserId = normalize(userId);
  const keyMaterial = normalize(apiKey);

  if (!scopeUserId) {
    throw new Error("ANGEL_ADAPTER_SCOPE_ERROR: userId is required for adapter creation.");
  }
  if (!keyMaterial || keyMaterial.length < 5) {
    throw new Error("ANGEL_ADAPTER_SCOPE_ERROR: apiKey is required for adapter creation.");
  }

  const outgoingIp = normalize(options?.outgoingIp);
  const agentUrl = normalize(options?.agentUrl);
  const isDataAccount = Boolean(options?.isDataAccount);
  const key = buildCacheKey(scopeUserId, keyMaterial, outgoingIp, agentUrl, isDataAccount);
  const now = Date.now();
  const cached = adapterCache.get(key);

  if (cached && cached.expiresAt > now) {
    if (cached.userId !== scopeUserId) {
      log.error("[ADAPTER_REGISTRY] Cache key collision detected — evicting stale entry", {
        expectedUserId: scopeUserId,
        cachedUserId: cached.userId,
      });
      adapterCache.delete(key);
    } else {
      return cached.adapter;
    }
  }

  const adapter = new AngelOneAdapter(
    keyMaterial,
    outgoingIp || undefined,
    isDataAccount,
    agentUrl || undefined
  );

  adapterCache.set(key, {
    adapter,
    expiresAt: now + ADAPTER_TTL_MS,
    userId: scopeUserId,
  });

  if (adapterCache.size > MAX_ADAPTER_CACHE) {
    const oldestKey = adapterCache.keys().next().value;
    if (oldestKey) adapterCache.delete(oldestKey);
  }

  log.debug("[ADAPTER_REGISTRY] Created user-scoped adapter", {
    userId: scopeUserId,
    isDataAccount,
    hasOutgoingIp: Boolean(outgoingIp),
    hasAgentUrl: Boolean(agentUrl),
  });

  return adapter;
}

/**
 * @deprecated Use getOrCreateUserAngelAdapter with an explicit userId.
 * Retained for system data feeds only when isDataAccount=true.
 */
export function getOrCreateAngelAdapter(
  apiKey: string,
  options?: UserAdapterOptions & { userId?: string }
) {
  const userId =
    normalize(options?.userId) || (options?.isDataAccount ? getSystemDataScopeUserId() : "");

  if (!userId) {
    throw new Error(
      "ANGEL_ADAPTER_DEPRECATED: getOrCreateAngelAdapter requires options.userId. Use getOrCreateUserAngelAdapter."
    );
  }

  return getOrCreateUserAngelAdapter(userId, apiKey, options);
}

export function clearAngelAdapterCache(userId?: string) {
  if (!userId) {
    adapterCache.clear();
    return;
  }
  const prefix = `${normalize(userId)}|`;
  for (const key of adapterCache.keys()) {
    if (key.startsWith(prefix)) adapterCache.delete(key);
  }
}

export function evictUserAngelAdapters(userId: string) {
  clearAngelAdapterCache(userId);
}
