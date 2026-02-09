"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLiveIndexLtp = getLiveIndexLtp;
exports.getInstrumentLtp = getInstrumentLtp;
exports.getLastIndexLtp = getLastIndexLtp;
exports.getLiveNiftyLtp = getLiveNiftyLtp;
const AngelOneAdapter_1 = require("../adapters/AngelOneAdapter");
const AngelTokens_1 = __importDefault(require("../models/AngelTokens"));
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const adapter = new AngelOneAdapter_1.AngelOneAdapter();
const ltpCache = new Map();
const CACHE_MS = 10000; // Increased to 10s to further reduce API load
let cooldownUntil = 0;
let lastRequestTime = 0;
const MIN_INTERVAL_MS = 800; // 800ms (~1.25 requests/sec)
async function throttledFetch(fn) {
    const now = Date.now();
    const wait = Math.max(0, lastRequestTime + MIN_INTERVAL_MS - now);
    lastRequestTime = now + wait;
    if (wait > 0)
        await new Promise(r => setTimeout(r, wait));
    // Check cooldown again AFTER wait to catch requests that were queued before a rate limit was hit
    if (Date.now() < cooldownUntil) {
        throw new Error("RATE_LIMIT_COOLDOWN");
    }
    return await fn();
}
function isInvalidTokenResponse(resp) {
    const code = resp?.errorcode || resp?.errorCode;
    const msg = String(resp?.message || "").toLowerCase();
    return code === "AG8001" || msg.includes("invalid token");
}
function isInvalidTokenError(err) {
    const msg = String(err?.message || err || "").toLowerCase();
    return msg.includes("ag8001") || msg.includes("invalid token");
}
function isRateLimitError(err) {
    const msg = String(err?.message || err?.data?.message || err?.errorcode || err || "").toLowerCase();
    return (msg.includes("403") ||
        msg.includes("429") ||
        msg.includes("access denied") ||
        msg.includes("exceeding access rate") ||
        msg.includes("rate limit") ||
        msg.includes("ag8002") ||
        msg.includes("rate_limit_cooldown"));
}
async function refreshAngelSession(session) {
    if (!session?.refreshToken) {
        throw new Error("Angel refreshToken missing. Please login again.");
    }
    const resp = await adapter.generateTokensUsingRefresh(session.refreshToken);
    if (!resp || resp.status === false || !resp.data) {
        logger_1.log.error("Angel refresh failed:", resp);
        throw new Error(resp?.message || "Angel refresh failed");
    }
    const tokensData = resp.data;
    const jwtToken = tokensData.jwtToken || tokensData.accessToken || tokensData.token;
    const refreshToken = tokensData.refreshToken || session.refreshToken;
    const feedToken = tokensData.websocketToken || tokensData.feedToken || session.feedToken;
    if (!jwtToken) {
        throw new Error("Angel refresh returned no jwtToken");
    }
    await AngelTokens_1.default.findOneAndUpdate({ clientcode: session.clientcode }, { jwtToken, refreshToken, feedToken, expiresAt: undefined }, { new: true }).lean();
    return { jwtToken };
}
async function getLtpInternal(jwtToken, exchange, symbol, token) {
    return await throttledFetch(() => adapter.getLtp(jwtToken, exchange, symbol, token));
}
async function getLiveIndexLtp(indexName = "NIFTY") {
    const cacheKey = `INDEX:${indexName}`;
    const now = Date.now();
    const cached = ltpCache.get(cacheKey);
    // 1. Return cache if fresh
    if (cached && (now - cached.ts < CACHE_MS)) {
        return cached.ltp;
    }
    // 2. Cooling down or disabled? Return last value or fallback
    if (now < cooldownUntil || config_1.config.disableLiveLtp) {
        if (cached?.ltp)
            return cached.ltp;
        if (config_1.config.nodeEnv !== "production") {
            const fallback = indexName === "NIFTY"
                ? config_1.config.fallbackNiftyLtp
                : indexName === "BANKNIFTY"
                    ? config_1.config.fallbackBankNiftyLtp
                    : config_1.config.fallbackFinNiftyLtp;
            return fallback || 0;
        }
        return 0;
    }
    try {
        const session = await AngelTokens_1.default.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 }).lean();
        if (!session || !session.jwtToken) {
            throw new Error(`No session for ${indexName} LTP`);
        }
        const indexConfig = {
            "NIFTY": { symbol: config_1.config.angelIndexSymbolNifty, token: config_1.config.angelIndexTokenNifty },
            "BANKNIFTY": { symbol: config_1.config.angelIndexSymbolBankNifty, token: config_1.config.angelIndexTokenBankNifty },
            "FINNIFTY": { symbol: config_1.config.angelIndexSymbolFinNifty, token: config_1.config.angelIndexTokenFinNifty }
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
            logger_1.log.warn(`Index LTP Rate limited (${indexName}). Cooling down 60s.`);
        }
    }
    catch (err) {
        if (isRateLimitError(err)) {
            cooldownUntil = now + 60000;
            logger_1.log.warn(`Index LTP Rate limit hit (${indexName}). Cooling down 60s.`);
        }
    }
    return cached?.ltp || 0;
}
async function getInstrumentLtp(exchange, tradingsymbol, symboltoken) {
    const cacheKey = `${exchange}:${symboltoken}`;
    const now = Date.now();
    const cached = ltpCache.get(cacheKey);
    if (cached && (now - cached.ts < CACHE_MS))
        return cached.ltp;
    if (now < cooldownUntil)
        return cached?.ltp || 0;
    try {
        const session = await AngelTokens_1.default.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 }).lean();
        if (!session?.jwtToken)
            return cached?.ltp || 0;
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
            logger_1.log.warn(`Instrument LTP Rate limited (${tradingsymbol}). Cooling down 60s.`);
        }
    }
    catch (err) {
        if (isRateLimitError(err)) {
            cooldownUntil = now + 60000;
            logger_1.log.warn(`Instrument LTP Rate limited (${tradingsymbol}). Cooling down 60s.`);
        }
    }
    return cached?.ltp || 0;
}
function getLastIndexLtp(indexName = "NIFTY") {
    return ltpCache.get(`INDEX:${indexName}`)?.ltp || 0;
}
async function getLiveNiftyLtp() {
    return getLiveIndexLtp("NIFTY");
}
