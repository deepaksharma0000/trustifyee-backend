import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import AngelTokensModel from "../models/AngelTokens";
import UpstoxTokensModel from "../models/UpstoxTokens";
import { UpstoxAdapter } from "../adapters/UpstoxAdapter";
import { config } from "../config";
import { log } from "../utils/logger";

const adapter = new AngelOneAdapter();
const upstoxAdapter = new UpstoxAdapter();
const ltpCache = new Map<string, { ltp: number, ts: number }>();
const CACHE_MS = 10000; // Increased to 10s to further reduce API load
let cooldownUntil = 0;
let lastRequestTime = 0;
const MIN_INTERVAL_MS = 800; // 800ms (~1.25 requests/sec)

const pendingRequests = new Map<string, Promise<any>>();

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
    const code = resp?.errorcode || resp?.errorCode;
    const msg = String(resp?.message || "").toLowerCase();
    return code === "AG8001" || msg.includes("invalid token");
}

function isInvalidTokenError(err: any) {
    const msg = String(err?.message || err || "").toLowerCase();
    return msg.includes("ag8001") || msg.includes("invalid token");
}

function isRateLimitError(err: any) {
    const msg = String(err?.message || err?.data?.message || err?.errorcode || err || "").toLowerCase();
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
    if (!session?.refreshToken) {
        throw new Error("Angel refreshToken missing. Please login again.");
    }
    const resp = await adapter.generateTokensUsingRefresh(session.refreshToken);
    if (!resp || resp.status === false || !resp.data) {
        log.error("Angel refresh failed:", resp);
        throw new Error(resp?.message || "Angel refresh failed");
    }
    const tokensData = resp.data;
    const jwtToken = tokensData.jwtToken || tokensData.accessToken || tokensData.token;
    const refreshToken = tokensData.refreshToken || session.refreshToken;
    const feedToken = tokensData.websocketToken || tokensData.feedToken || session.feedToken;
    if (!jwtToken) {
        throw new Error("Angel refresh returned no jwtToken");
    }
    await AngelTokensModel.findOneAndUpdate(
        { clientcode: session.clientcode },
        { jwtToken, refreshToken, feedToken, expiresAt: undefined },
        { new: true }
    ).lean();
    return { jwtToken };
}

async function getLtpInternal(jwtToken: string, exchange: string, symbol: string, token: string) {
    const key = `${exchange}:${symbol}:${token}`;
    return await throttledFetch(key, () => adapter.getLtp(jwtToken, exchange, symbol, token));
}

export async function getLiveIndexLtp(indexName: "NIFTY" | "BANKNIFTY" | "FINNIFTY" = "NIFTY"): Promise<number> {
    const cacheKey = `INDEX:${indexName}`;
    const now = Date.now();
    const cached = ltpCache.get(cacheKey);

    // 1. Return cache if fresh
    if (cached && (now - cached.ts < CACHE_MS)) {
        return cached.ltp;
    }

    // 2. Cooling down or disabled? Return last value or fallback
    if (now < cooldownUntil || config.disableLiveLtp) {
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
        return 0;
    }

    try {
        const session: any = await AngelTokensModel.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 }).lean();

        if (session && session.jwtToken) {
            const indexConfig: Record<string, { symbol: string, token: string }> = {
                "NIFTY": { symbol: config.angelIndexSymbolNifty, token: config.angelIndexTokenNifty },
                "BANKNIFTY": { symbol: config.angelIndexSymbolBankNifty, token: config.angelIndexTokenBankNifty },
                "FINNIFTY": { symbol: config.angelIndexSymbolFinNifty, token: config.angelIndexTokenFinNifty }
            };
            const index = indexConfig[indexName];

            let resp = await getLtpInternal(session.jwtToken, "NSE", index.symbol, index.token);

            if (isInvalidTokenResponse(resp)) {
                try {
                    const refreshed = await refreshAngelSession(session);
                    resp = await getLtpInternal(refreshed.jwtToken, "NSE", index.symbol, index.token);
                } catch (reErr) {
                    log.warn(`Angel refresh failed for ${indexName} LTP index:`, reErr);
                }
            }

            if (resp && resp.status === true && resp.data) {
                const ltp = Number(resp.data.ltp);
                if (!Number.isNaN(ltp) && ltp > 0) {
                    ltpCache.set(cacheKey, { ltp, ts: now });
                    return ltp;
                }
            }
            if (resp && isRateLimitError(resp)) {
                cooldownUntil = now + 60000;
                log.warn(`Index LTP Rate limited (${indexName}). Cooling down 60s.`);
            }
        }

        // 3. Fallback to Upstox if Angel failed or no session
        const upstoxDoc = await UpstoxTokensModel.findOne({ accessToken: { $exists: true } }).sort({ updatedAt: -1 }).lean();
        if (upstoxDoc?.accessToken) {
            const upstoxMap: Record<string, string> = {
                NIFTY: "NSE_INDEX|Nifty 50",
                BANKNIFTY: "NSE_INDEX|Nifty Bank",
                FINNIFTY: "NSE_INDEX|Nifty Fin Service",
            };
            const upstoxKey = upstoxMap[indexName];
            if (upstoxKey) {
                const apiResp = await upstoxAdapter.getLtp(upstoxDoc.accessToken, upstoxKey);
                const data = apiResp?.data || {};
                let entry = data[upstoxKey as keyof typeof data];
                if (!entry) {
                    const altKey = upstoxKey.replace("|", ":");
                    entry = data[altKey as keyof typeof data];
                }
                const ltp = entry?.last_price;
                if (ltp && !Number.isNaN(ltp)) {
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

    return cached?.ltp || 0;
}

export async function getInstrumentLtp(exchange: string, tradingsymbol: string, symboltoken: string): Promise<number> {
    const cacheKey = `${exchange}:${symboltoken}`;
    const now = Date.now();
    const cached = ltpCache.get(cacheKey);

    if (cached && (now - cached.ts < CACHE_MS)) return cached.ltp;
    if (now < cooldownUntil) return cached?.ltp || 0;

    try {
        const isUpstox = symboltoken.includes("|") || exchange === "NSE_FO" || symboltoken.length > 20;

        if (isUpstox) {
            const upstoxDoc = await UpstoxTokensModel.findOne({ accessToken: { $exists: true } }).sort({ updatedAt: -1 }).lean();
            if (upstoxDoc?.accessToken) {
                const apiResp = await upstoxAdapter.getLtp(upstoxDoc.accessToken, symboltoken);
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
            const session: any = await AngelTokensModel.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 }).lean();
            if (session?.jwtToken) {
                let resp = await getLtpInternal(session.jwtToken, exchange, tradingsymbol, symboltoken);
                if (isInvalidTokenResponse(resp)) {
                    try {
                        const refreshed = await refreshAngelSession(session);
                        resp = await getLtpInternal(refreshed.jwtToken, exchange, tradingsymbol, symboltoken);
                    } catch (reErr) {
                        log.warn(`Angel refresh failed for ${tradingsymbol} LTP:`, reErr);
                    }
                }

                if (resp && resp.status === true && resp.data) {
                    const ltp = Number(resp.data.ltp);
                    if (!Number.isNaN(ltp) && ltp > 0) {
                        ltpCache.set(cacheKey, { ltp, ts: now });
                        return ltp;
                    }
                }
                if (resp && isRateLimitError(resp)) {
                    cooldownUntil = now + 60000;
                    log.warn(`Instrument LTP Rate limited (${tradingsymbol}). Cooling down 60s.`);
                }
            }
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

export function getLastIndexLtp(indexName: "NIFTY" | "BANKNIFTY" | "FINNIFTY" = "NIFTY") {
    return ltpCache.get(`INDEX:${indexName}`)?.ltp || 0;
}

export async function getLiveNiftyLtp(): Promise<number> {
    return getLiveIndexLtp("NIFTY");
}
