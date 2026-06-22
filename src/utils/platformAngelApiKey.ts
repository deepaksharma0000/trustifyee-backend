import { config } from "../config";

/**
 * Platform SmartAPI key — DATA FEEDS / admin market utilities ONLY.
 * User trading (connect, refresh, placeOrder) must NEVER use this key.
 */
export function getPlatformAngelApiKey(): string {
  return String(config.angelApiKey || "").trim();
}

/**
 * @deprecated User trading always uses per-user SmartAPI Private Key (Working System A).
 * Returns false for all broker connect / order execution paths.
 */
export function shouldUsePlatformAngelApiKey(_profile?: unknown): boolean {
  if (process.env.USE_PLATFORM_ANGEL_API_KEY === "true") {
    // Explicit opt-in via env is ignored for end-user trading — log once at startup via config validation.
  }
  return false;
}

/** True only for dedicated system data account adapters (TickEngine / DATA_API_KEY). */
export function isPlatformKeyForDataFeedOnly(): boolean {
  return Boolean(String(config.dataApiKey || "").trim() || getPlatformAngelApiKey().length >= 6);
}
