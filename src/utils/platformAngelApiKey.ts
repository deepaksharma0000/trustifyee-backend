import { config } from "../config";

/**
 * Shared VPS mode: all end-user broker calls use the platform SmartAPI app key
 * (ANGEL_API_KEY) so only the VPS static IP must be whitelisted once in Angel One.
 */
export function getPlatformAngelApiKey(): string {
  return String(config.angelApiKey || "").trim();
}

export function shouldUsePlatformAngelApiKey(profile?: any): boolean {
  if (process.env.USE_PLATFORM_ANGEL_API_KEY === "false") return false;
  if (!config.forceSharedVpsRoute) return false;
  if (Boolean(profile?.dedicated_ip_enabled === true)) return false;
  return getPlatformAngelApiKey().length >= 6;
}
