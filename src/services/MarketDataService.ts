import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import AngelTokensModel from "../models/AngelTokens";
import UpstoxTokensModel from "../models/UpstoxTokens";
import { UpstoxAdapter } from "../adapters/UpstoxAdapter";
import { config } from "../config";
import log from "../utils/logger";
import { ensureEncrypted } from "../utils/encryption";
import { recoverSessionByRefreshOrLogin } from "./AngelSessionLifecycleService";

// Removed global adapters to enforce per-user keys
// const adapter = new AngelOneAdapter();
// const upstoxAdapter = new UpstoxAdapter();
let _upstoxAdapter: UpstoxAdapter | null = null;
function getUpstoxAdapter() {
    if (!_upstoxAdapter) _upstoxAdapter = new UpstoxAdapter();
    return _upstoxAdapter;
}
const ltpCache = new Map<string, { ltp: number, ts: number }>();
const warningCache = new Map<string, number>();
const CACHE_MS = 1500; // 1.5s for real-time feel
let cooldownUntil = 0;
let lastRequestTime = 0;
const MIN_INTERVAL_MS = 350; // Balanced for approx 2.8 req/sec (staying under 3/sec limit)

const pendingRequests = new Map<string, Promise<any>>();

function shouldLogWarning(key: string, windowMs = 60000) {
    const now = Date.now();
    const last = warningCache.get(key) || 0;
    if (now - last < windowMs) return false;
    warningCache.set(key, now);
    return true;
}

async function throttledFetch<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // 🚀 [REQUEST COLLAPSING]
    // If a request for this exact key is already in flight, join it instead of queuing a new one
    if (pendingRequests.has(key)) {
        return pendingRequests.get(key);
    }

    const fetchPromise = (async () => {
        try {
            const now = Date.now();
            const wait = Math.max(0, lastRequestTime + MIN_INTERVAL_MS - now);
            lastRequestTime = now + wait;
            if (wait > 0) await new Promise(r => setTimeout(r, wait));

            if (Date.now() < cooldownUntil) {
                throw new Error("RATE_LIMIT_COOLDOWN");
            }

            return await fn();
        } finally {
            // Remove from pending map once finished (success or fail)
            pendingRequests.delete(key);
        }
    })();

    pendingRequests.set(key, fetchPromise);
    return fetchPromise;
}

function isInvalidTokenResponse(resp: any) {
    const body = resp?.data || resp || {};
    const code = body?.errorCode || body?.errorcode || body?.code || resp?.errorCode || resp?.errorcode;
    const msg = String(body?.message || resp?.message || "").toLowerCase();
    return String(code || "").toUpperCase() === "AG8001" || msg.includes("invalid token");
}

function isInvalidTokenError(err: any) {
    const msg = String(err?.message || err || "").toLowerCase();
    return msg.includes("ag8001") || msg.includes("invalid token");
}

function isRateLimitError(err: any) {
    const body = err?.data || err?.response?.data || {};
    const msg = String(err?.message || body?.message || body?.errorCode || body?.errorcode || err || "").toLowerCase();
    return (
        msg.includes("403") ||
        msg.includes("429") ||
        msg.includes("access denied") ||
        msg.includes("exceeding access rate") ||
        msg.includes("rate limit") ||
        msg.includes("ag8002") ||
        msg.includes("rate_limit_cooldown")
    );
}

async function refreshAngelSession(session: any) {
    const recovery = await recoverSessionByRefreshOrLogin(session, "market_data");
    if (!recovery.ok || !recovery.jwtToken) {
        throw new Error(recovery.reason || "SESSION_RECOVERY_FAILED");
    }

    // Ensure API key is available after recovery (refresh or fresh login)
    let sessionApiKey = await ensureEncrypted(session, 'apiKey', `market_data_refresh_${session.clientcode}`);
    if (!sessionApiKey) {
        const latestSession = await AngelTokensModel.findById(session._id);
        if (latestSession) {
            sessionApiKey = await ensureEncrypted(latestSession, 'apiKey', `market_data_refresh_latest_${session.clientcode}`);
        }
    }

    if (!sessionApiKey) {
        throw new Error("API Key missing after session recovery");
    }

    return { jwtToken: recovery.jwtToken, apiKey: sessionApiKey };
}

async function getLtpInternal(jwtToken: string, exchange: string, symbol: string, token: string, apiKey: string) {
    const key = `${exchange}:${symbol}:${token}`;
    const dynamicAdapter = new AngelOneAdapter(apiKey);
    return await throttledFetch(key, () => dynamicAdapter.getLtp(jwtToken, exchange, symbol, token));
}

export async function getLiveIndexLtp(indexName: "NIFTY" | "BANKNIFTY" | "FINNIFTY" = "NIFTY"): Promise<number> {
    log.info(`[LTP_FLOW_TRIGGERED] Fetching index LTP for ${indexName}`);
    const cacheKey = `INDEX:${indexName}`;
    const now = Date.now();
    const cached = ltpCache.get(cacheKey);

    // 1. Return cache if fresh
    if (cached && (now - cached.ts < CACHE_MS)) {
        return cached.ltp;
    }

    // 2. Refresh logic
    try {
        if (now >= cooldownUntil && !config.disableLiveLtp) {
            const session = await AngelTokensModel.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 });

            if (session && session.jwtToken) {
                const indexConfig: Record<string, { symbol: string, token: string }> = {
                    "NIFTY": { symbol: config.angelIndexSymbolNifty, token: config.angelIndexTokenNifty },
                    "BANKNIFTY": { symbol: config.angelIndexSymbolBankNifty, token: config.angelIndexTokenBankNifty },
                    "FINNIFTY": { symbol: config.angelIndexSymbolFinNifty, token: config.angelIndexTokenFinNifty }
                };
                const index = indexConfig[indexName];
                if (!session.apiKey) throw new Error("User API Key missing for index fetching");
                
                const decJwtToken = await ensureEncrypted(session, 'jwtToken', `market_data_index_val_${indexName}`);
                const sessionApiKey = await ensureEncrypted(session, 'apiKey', `market_data_index_${indexName}`);
                
                let resp = await getLtpInternal(decJwtToken, "NSE", index.symbol, index.token, sessionApiKey);

                if (isInvalidTokenResponse(resp)) {
                    try {
                        const refreshed = await refreshAngelSession(session);
                        resp = await getLtpInternal(refreshed.jwtToken, "NSE", index.symbol, index.token, refreshed.apiKey);
                    } catch (reErr) {
                        if (shouldLogWarning(`REFRESH_FAIL_INDEX:${session?.clientcode || "UNKNOWN"}:${indexName}`)) {
                            log.warn(`Angel refresh failed for ${indexName} LTP index:`, reErr);
                        }
                    }
                }

                if (resp && resp.status === 200 && resp.data) {
                    const ltp = Number(resp.data.ltp || resp.data.lastPrice || 0);
                    if (!Number.isNaN(ltp) && ltp > 0) {
                        ltpCache.set(cacheKey, { ltp, ts: now });
                        return ltp;
                    } else if (ltp === 0 && shouldLogWarning(`INDEX_ZERO:${indexName}`)) {
                        log.warn(`[INDEX_ZERO_LTP] Received 0 for ${indexName}. Raw: ${JSON.stringify(resp.data)}`);
                    }
                }
                if (resp && isRateLimitError(resp)) {
                    cooldownUntil = now + 60000;
                    log.warn(`Index LTP Rate limited (${indexName}). Cooling down 60s.`);
                }
            }
        }

        // 3. Fallback to Upstox if Angel failed, is on cooldown, or no session
        const upstoxDoc = await UpstoxTokensModel.findOne({ accessToken: { $exists: true } }).sort({ updatedAt: -1 }).lean();
        if (upstoxDoc?.accessToken) {
            const upstoxMap: Record<string, string> = {
                NIFTY: "NSE_INDEX|Nifty 50",
                BANKNIFTY: "NSE_INDEX|Nifty Bank",
                FINNIFTY: "NSE_INDEX|Nifty Fin Service",
            };
            const upstoxKey = upstoxMap[indexName];
            if (upstoxKey) {
                const apiResp = await getUpstoxAdapter().getLtp(upstoxDoc.accessToken, upstoxKey);
                const data = apiResp?.data || {};
                let entry = data[upstoxKey as keyof typeof data];
                if (!entry) {
                    const altKey = upstoxKey.replace("|", ":");
                    entry = data[altKey as keyof typeof data];
                }
                const ltp = entry?.last_price;
                if (ltp && !Number.isNaN(ltp) && ltp > 0) {
                    ltpCache.set(cacheKey, { ltp, ts: now });
                    return ltp;
                }
            }
        }

    } catch (err: any) {
        if (isRateLimitError(err)) {
            cooldownUntil = now + 60000;
            log.warn(`Index LTP Rate limit hit (${indexName}). Cooling down 60s.`);
        } else {
            log.error(`Index LTP fetch error (${indexName}):`, err.message || err);
        }
    }

    // 4. Ultimate fallback: Return latest cache or 0/config
    if (cached?.ltp) return cached.ltp;
    
    if (config.nodeEnv !== "production") {
        const fallback =
            indexName === "NIFTY"
                ? config.fallbackNiftyLtp
                : indexName === "BANKNIFTY"
                    ? config.fallbackBankNiftyLtp
                    : config.fallbackFinNiftyLtp;
        return fallback || 0;
    }

    return cached?.ltp || 0;
}

export async function getInstrumentLtp(exchange: string, tradingsymbol: string, symboltoken: string): Promise<number> {
    const cacheKey = `${exchange}:${symboltoken}`;
    const now = Date.now();
    const cached = ltpCache.get(cacheKey);

    if (cached && (now - cached.ts < CACHE_MS)) return cached.ltp;
    try {
        const isUpstox = symboltoken.includes("|") || exchange === "NSE_FO" || symboltoken.length > 20;

        if (isUpstox) {
            const upstoxDoc = await UpstoxTokensModel.findOne({ accessToken: { $exists: true } }).sort({ updatedAt: -1 }).lean();
            if (upstoxDoc?.accessToken) {
                const apiResp = await getUpstoxAdapter().getLtp(upstoxDoc.accessToken, symboltoken);
                const data = apiResp?.data || {};
                let entry = data[symboltoken as keyof typeof data];
                if (!entry) {
                    const altKey = symboltoken.replace("|", ":");
                    entry = data[altKey as keyof typeof data];
                }
                const ltp = entry?.last_price;
                if (ltp && !Number.isNaN(ltp)) {
                    ltpCache.set(cacheKey, { ltp, ts: now });
                    return ltp;
                }
            }
        } else {
            // Only try Angel if not in cooldown
            if (now >= cooldownUntil) {
                const session = await AngelTokensModel.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 });
                if (session && session.jwtToken) {
                    if (!session.apiKey) throw new Error("User API Key missing for instrument fetching");
                    
                    const decJwtToken = await ensureEncrypted(session, 'jwtToken', `market_data_instrument_val_${symboltoken}`);
                    const sessionApiKey = await ensureEncrypted(session, 'apiKey', `market_data_instrument_${symboltoken}`);
                    
                    let resp = await getLtpInternal(decJwtToken, exchange, tradingsymbol, symboltoken, sessionApiKey);
                    if (isInvalidTokenResponse(resp)) {
                        try {
                            const refreshed = await refreshAngelSession(session);
                            resp = await getLtpInternal(refreshed.jwtToken, exchange, tradingsymbol, symboltoken, refreshed.apiKey);
                        } catch (reErr) {
                            if (shouldLogWarning(`REFRESH_FAIL_SYMBOL:${session?.clientcode || "UNKNOWN"}:${tradingsymbol}`)) {
                                log.warn(`Angel refresh failed for ${tradingsymbol} LTP:`, reErr);
                            }
                        }
                    }

                    if (resp && resp.status === 200 && resp.data) {
                        const ltp = Number(resp.data.ltp || resp.data.lastPrice || 0);
                        if (!Number.isNaN(ltp) && ltp > 0) {
                            ltpCache.set(cacheKey, { ltp, ts: now });
                            return ltp;
                        } else if (ltp === 0 && shouldLogWarning(`INSTRUMENT_ZERO:${tradingsymbol}:${symboltoken}`)) {
                            log.warn(`[INSTRUMENT_ZERO_LTP] Received 0 for ${tradingsymbol}. Raw: ${JSON.stringify(resp.data)}`);
                        }
                    }
                    if (resp && isRateLimitError(resp)) {
                        cooldownUntil = now + 60000;
                        log.warn(`Instrument LTP Rate limited (${tradingsymbol}). Cooling down 60s.`);
                    }
                }
            }

            // [IF ANGEL FAILED] Try Upstox as secondary for normal instruments too if possible (assuming symboltoken mapping)
            // Note: Upstox needs a different instrument key usually. Skipping for now unless it's already an index.
        }
    } catch (err: any) {
        if (isRateLimitError(err)) {
            cooldownUntil = now + 60000;
            log.warn(`Instrument LTP Rate limit hit (${tradingsymbol}). Cooling down 60s.`);
        } else {
            log.error(`Instrument LTP error (${tradingsymbol}):`, err.message || err);
        }
    }

    return cached?.ltp || 0;
}

/**
 * 🚀 [BATCH LTP] Fetch live prices for multiple tokens at once.
 * Reduces API hits and improves Option Chain performance.
 */
export async function getMultipleInstrumentsLtp(payload: Record<string, string[]>): Promise<Record<string, number>> {
    const results: Record<string, number> = {};
    const now = Date.now();
    
    // 1. Resolve from cache first
    for (const exch in payload) {
        payload[exch] = payload[exch].filter(token => {
            const cacheKey = `${exch}:${token}`;
            const cached = ltpCache.get(cacheKey);
            if (cached && (now - cached.ts < CACHE_MS)) {
                results[token] = cached.ltp;
                return false; // Skip already cached
            }
            return true;
        });
    }

    // 2. Fetch missing from AngelOne
    const remainingCount = Object.values(payload).flat().length;
    if (remainingCount > 0 && now >= cooldownUntil) {
        try {
            const session = await AngelTokensModel.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 });
            if (session && session.jwtToken && session.apiKey) {
                const decJwtToken = await ensureEncrypted(session, 'jwtToken', 'batch_ltp_val');
                const sessionApiKey = await ensureEncrypted(session, 'apiKey', 'batch_ltp');
                
                const dynamicAdapter = new AngelOneAdapter(sessionApiKey);
                const resp = await throttledFetch('BATCH_LTP', () => dynamicAdapter.getMarketData(decJwtToken, "FULL", payload));
                
                if (resp && resp.status === 200 && resp.data && resp.data.data) {
                    const angelData = resp.data.data;
                    const fetched = Array.isArray(angelData) ? angelData : (angelData.fetched || []);
                    
                    fetched.forEach((item: any) => {
                        const ltp = Number(item.ltp || 0);
                        const lastPrice = Number(item.lastPrice || 0);
                        const close = Number(item.close || 0);
                        
                        const finalLtp = ltp || lastPrice || close || 0;
                        const token = item.symbolToken || item.symboltoken; // Handle both casings from broker

                        if (finalLtp > 0 && token) {
                            results[token.toLowerCase()] = finalLtp;
                            ltpCache.set(`${item.exchange}:${token}`, { ltp: finalLtp, ts: now });
                        }
                    });
                }
            }
        } catch (err: any) {
            log.error("Batch LTP Fetch error:", err.message);
        }
    }

    return results;
}

export function getLastIndexLtp(indexName: "NIFTY" | "BANKNIFTY" | "FINNIFTY" = "NIFTY") {
    return ltpCache.get(`INDEX:${indexName}`)?.ltp || 0;
}

export async function getLiveNiftyLtp(): Promise<number> {
    return getLiveIndexLtp("NIFTY");
}
