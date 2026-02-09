import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import AngelTokensModel from "../models/AngelTokens";
import { config } from "../config";
import { log } from "../utils/logger";

const adapter = new AngelOneAdapter();
const ltpCache = new Map<string, { ltp: number, ts: number }>();
const CACHE_MS = 5000;
let cooldownUntil = 0;
let lastRequestTime = 0;
const MIN_INTERVAL_MS = 350; // Proactive throttling (~3 requests per second)

async function throttledFetch<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const wait = Math.max(0, lastRequestTime + MIN_INTERVAL_MS - now);
    lastRequestTime = now + wait;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    return await fn();
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
        msg.includes("ag8002")
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
    return await throttledFetch(() => adapter.getLtp(jwtToken, exchange, symbol, token));
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
        if (!session || !session.jwtToken) {
            throw new Error(`No session for ${indexName} LTP`);
        }

        const indexConfig: Record<string, { symbol: string, token: string }> = {
            "NIFTY": { symbol: config.angelIndexSymbolNifty, token: config.angelIndexTokenNifty },
            "BANKNIFTY": { symbol: config.angelIndexSymbolBankNifty, token: config.angelIndexTokenBankNifty },
            "FINNIFTY": { symbol: config.angelIndexSymbolFinNifty, token: config.angelIndexTokenFinNifty }
        };
        const index = indexConfig[indexName];

        let resp = await getLtpInternal(session.jwtToken, "NSE", index.symbol, index.token);

        if (isInvalidTokenResponse(resp)) {
            const refreshed = await refreshAngelSession(session);
            resp = await getLtpInternal(refreshed.jwtToken, "NSE", index.symbol, index.token);
        }

        if (resp && resp.status === true && resp.data) {
            const ltp = Number(resp.data.ltp);
            if (!Number.isNaN(ltp) && ltp > 0) {
                ltpCache.set(cacheKey, { ltp, ts: now });
                return ltp;
            }
        }

        if (resp?.status === false && isRateLimitError(resp)) {
            cooldownUntil = now + 60000;
            log.warn(`Index LTP Rate limited (${indexName}). Cooling down 60s.`);
        }
    } catch (err: any) {
        if (isRateLimitError(err)) {
            cooldownUntil = now + 60000;
            log.warn(`Index LTP Rate limit hit (${indexName}). Cooling down 60s.`);
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
        const session: any = await AngelTokensModel.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 }).lean();
        if (!session?.jwtToken) return cached?.ltp || 0;

        const resp = await getLtpInternal(session.jwtToken, exchange, tradingsymbol, symboltoken);

        if (resp && resp.status === true && resp.data) {
            const ltp = Number(resp.data.ltp);
            if (!Number.isNaN(ltp) && ltp > 0) {
                ltpCache.set(cacheKey, { ltp, ts: now });
                return ltp;
            }
        }

        if (resp?.status === false && isRateLimitError(resp)) {
            cooldownUntil = now + 60000;
            log.warn(`Instrument LTP Rate limited (${tradingsymbol}). Cooling down 60s.`);
        }
    } catch (err: any) {
        if (isRateLimitError(err)) {
            cooldownUntil = now + 60000;
            log.warn(`Instrument LTP Rate limited (${tradingsymbol}). Cooling down 60s.`);
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
