import { AngelOneAdapter } from "../adapters/AngelOneAdapter";

type AdapterEntry = {
  adapter: AngelOneAdapter;
  expiresAt: number;
};

const ADAPTER_TTL_MS = 15 * 60 * 1000;
const MAX_ADAPTER_CACHE = 200;
const adapterCache = new Map<string, AdapterEntry>();

const normalize = (value?: string) => (value || "").toString().trim();

const adapterKey = (apiKey: string, outgoingIp?: string, agentUrl?: string, isDataAccount = false) =>
  [normalize(apiKey), normalize(outgoingIp), normalize(agentUrl), isDataAccount ? "DATA" : "USER"].join("|");

export function getOrCreateAngelAdapter(
  apiKey: string,
  options?: { outgoingIp?: string; agentUrl?: string; isDataAccount?: boolean }
) {
  const outgoingIp = normalize(options?.outgoingIp);
  const agentUrl = normalize(options?.agentUrl);
  const isDataAccount = Boolean(options?.isDataAccount);

  const key = adapterKey(apiKey, outgoingIp, agentUrl, isDataAccount);
  const now = Date.now();
  const cached = adapterCache.get(key);

  if (cached && cached.expiresAt > now) {
    return cached.adapter;
  }

  const adapter = new AngelOneAdapter(apiKey, outgoingIp || undefined, isDataAccount, agentUrl || undefined);
  adapterCache.set(key, {
    adapter,
    expiresAt: now + ADAPTER_TTL_MS,
  });

  if (adapterCache.size > MAX_ADAPTER_CACHE) {
    const oldestKey = adapterCache.keys().next().value;
    if (oldestKey) adapterCache.delete(oldestKey);
  }

  return adapter;
}

export function clearAngelAdapterCache() {
  adapterCache.clear();
}
