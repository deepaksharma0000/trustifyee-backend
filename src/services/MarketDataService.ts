import AngelTokensModel from "../models/AngelTokens";
import UpstoxTokensModel from "../models/UpstoxTokens";
import InstrumentModel from "../models/Instrument";
import User from "../models/User";
import Admin from "../models/Admin";
import { UpstoxAdapter } from "../adapters/UpstoxAdapter";
import { config } from "../config";
import log from "../utils/logger";
import { ensureEncrypted } from "../utils/encryption";
import { recoverSessionByRefreshOrLogin } from "./AngelSessionLifecycleService";
import { getOrCreateUserAngelAdapter, getSystemDataScopeUserId } from "./AngelAdapterRegistry";
import { resolveAngelSessionContext } from "./AngelSessionContextService";
import { validateInstrumentFromMaster } from "./InstrumentValidationService";

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
const SYSTEM_DATA_CLIENTCODE = String(config.dataClientCode || "").trim();
const tokenRepairCooldown = new Map<string, number>();
const TOKEN_REPAIR_COOLDOWN_MS = 10 * 60 * 1000;
const TOKEN_REPAIR_AUTH_COOLDOWN_MS = 30 * 60 * 1000;
const ENABLE_LIVE_TOKEN_REPAIR = process.env.ENABLE_LIVE_TOKEN_REPAIR === "true";

export type SessionHint = {
    userId?: string;
    clientcode?: string;
};

async function resolveSessionForMarket(purpose: string, hint?: SessionHint) {
    const hintedUserId = hint?.userId ? String(hint.userId).trim() : "";
    const hintedClientcode = hint?.clientcode ? String(hint.clientcode).trim() : "";
    const clientcode = hintedClientcode || SYSTEM_DATA_CLIENTCODE;

    if (!hintedUserId && !clientcode) {
        return null;
    }

    return resolveAngelSessionContext({
        userId: hintedUserId || undefined,
        clientcode: clientcode || undefined,
        allowGlobalFallback: false,
        strictIdentity: true,
        requireJwt: true,
        purpose,
    });
}

function extractAngelPayload(response: any) {
    const body = response?.data ?? response ?? {};
    const payload =
        body?.data && typeof body.data === "object" && !Array.isArray(body.data)
            ? body.data
            : body;
    const errorCode = String(
        body?.errorCode || body?.errorcode || payload?.errorCode || payload?.errorcode || ""
    ).toUpperCase();
    const message = String(body?.message || payload?.message || "");
    return { body, payload, errorCode, message };
}

function extractAngelLtp(response: any) {
    const { body, payload, errorCode, message } = extractAngelPayload(response);
    const ltp = Number(payload?.ltp || payload?.lastPrice || payload?.close || 0);
    const token = String(payload?.symboltoken || payload?.symbolToken || "").trim();
    const symbol = String(payload?.tradingsymbol || payload?.tradingSymbol || "").trim().toUpperCase();
    return { body, payload, errorCode, message, ltp, token, symbol };
}

async function resolveSessionApiKey(session: any, context: string): Promise<string> {
    let sessionApiKey = await ensureEncrypted(session, "apiKey", `${context}_session_api_${session?.clientcode || "UNKNOWN"}`);
    if (sessionApiKey) return sessionApiKey;

    if (session?._id) {
        const latestSession = await AngelTokensModel.findById(session._id);
        if (latestSession) {
            sessionApiKey = await ensureEncrypted(latestSession, "apiKey", `${context}_latest_api_${session?.clientcode || "UNKNOWN"}`);
            if (sessionApiKey) return sessionApiKey;
        }
    }

    const userId = String(session?.userId || "").trim();
    const sessionClientcode = String(session?.clientcode || "").trim();
    if (!userId) {
        if (sessionClientcode) {
            const sameClientSession = await AngelTokensModel.findOne({
                clientcode: sessionClientcode,
                apiKey: { $exists: true, $ne: "" },
            })
                .sort({ updatedAt: -1 })
                .lean() as any;
            if (sameClientSession?.apiKey) {
                const sameClientApiKey = await ensureEncrypted(
                    sameClientSession,
                    "apiKey",
                    `${context}_same_client_api_${sessionClientcode}`
                );
                if (sameClientApiKey) {
                    return sameClientApiKey;
                }
            }
        }

        if (
            SYSTEM_DATA_CLIENTCODE &&
            sessionClientcode === SYSTEM_DATA_CLIENTCODE &&
            String(config.dataApiKey || "").trim().length > 4
        ) {
            return String(config.dataApiKey).trim();
        }

        return "";
    }

    const userDoc = await User.findById(userId).select("api_key").lean() as any;
    const adminDoc = !userDoc ? await Admin.findById(userId).select("api_key").lean() as any : null;
    const profile = userDoc || adminDoc;
    if (!profile?.api_key) {
        const siblingSession = await AngelTokensModel.findOne({
            userId,
            apiKey: { $exists: true, $ne: "" },
        })
            .sort({ updatedAt: -1 })
            .lean() as any;
        if (siblingSession?.apiKey) {
            const siblingApiKey = await ensureEncrypted(
                siblingSession,
                "apiKey",
                `${context}_sibling_api_${userId}`
            );
            if (siblingApiKey) {
                try {
                    await AngelTokensModel.updateMany(
                        { userId, clientcode: session?.clientcode },
                        { $set: { apiKey: siblingSession.apiKey } }
                    );
                } catch {
                    // best effort
                }
                return siblingApiKey;
            }
        }

        if (
            SYSTEM_DATA_CLIENTCODE &&
            String(session?.clientcode || "").trim() === SYSTEM_DATA_CLIENTCODE &&
            String(config.dataApiKey || "").trim().length > 4
        ) {
            return String(config.dataApiKey).trim();
        }

        return "";
    }

    const profileApiKey = await ensureEncrypted(profile, "api_key", `${context}_profile_api_${userId}`);
    if (!profileApiKey) {
        return "";
    }

    try {
        await AngelTokensModel.updateMany(
            { userId, clientcode: session?.clientcode },
            { $set: { apiKey: profile.api_key } }
        );
    } catch (err: any) {
        log.warn("[MARKET_DATA] Failed to backfill apiKey into AngelTokens", {
            userId,
            clientcode: session?.clientcode,
            message: err?.message,
        });
    }

    return profileApiKey;
}

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
    const { errorCode, message } = extractAngelPayload(resp);
    const msg = String(message || "").toLowerCase();
    return errorCode === "AG8001" || msg.includes("invalid token");
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
    const sessionApiKey = await resolveSessionApiKey(session, "market_data_refresh");

    if (!sessionApiKey) {
        throw new Error("API Key missing after session recovery");
    }

    return { jwtToken: recovery.jwtToken, apiKey: sessionApiKey };
}

async function getLtpInternal(
    jwtToken: string,
    exchange: string,
    symbol: string,
    token: string,
    apiKey: string,
    scopeUserId = getSystemDataScopeUserId()
) {
    const key = `${exchange}:${symbol}:${token}`;
    const dynamicAdapter = getOrCreateUserAngelAdapter(scopeUserId, apiKey);
    return await throttledFetch(key, () => dynamicAdapter.getLtp(jwtToken, exchange, symbol, token));
}

function isSymbolCacheMissResponse(resp: any) {
    const { errorCode, message } = extractAngelPayload(resp);
    const normalizedMessage = String(message || "").toLowerCase();
    return errorCode === "AB4046" || normalizedMessage.includes("symbol token not found in scrip master cache");
}

function isDataClientSession(session: any) {
    const clientcode = String(session?.clientcode || "").trim();
    return Boolean(SYSTEM_DATA_CLIENTCODE) && clientcode === SYSTEM_DATA_CLIENTCODE;
}

async function attemptLiveTokenRepair(
    scopeUserId: string,
    sessionApiKey: string,
    jwtToken: string,
    exchange: string,
    tradingsymbol: string
) {
    const normalizedExchange = String(exchange || "").trim().toUpperCase();
    const normalizedSymbol = String(tradingsymbol || "").trim().toUpperCase();
    const repairKey = `${normalizedExchange}:${normalizedSymbol}`;
    const now = Date.now();
    const cooldownUntil = tokenRepairCooldown.get(repairKey) || 0;
    if (cooldownUntil > now) {
        return "";
    }

    try {
        const adapter = getOrCreateUserAngelAdapter(scopeUserId, sessionApiKey);
        const response = await adapter.searchScrip(jwtToken, exchange, tradingsymbol);
        const body = response?.data || {};
        const payload = body?.data || body;
        const list = Array.isArray(payload) ? payload : Array.isArray(payload?.fetched) ? payload.fetched : [];
        const exact = list.find((item: any) => String(item?.tradingsymbol || "").trim().toUpperCase() === normalizedSymbol);
        const candidate = exact || list[0];
        const repairedToken = String(candidate?.symboltoken || candidate?.symbolToken || "").trim();

        if (!repairedToken) {
            tokenRepairCooldown.set(repairKey, now + TOKEN_REPAIR_COOLDOWN_MS);
            return "";
        }

        await InstrumentModel.updateOne(
            { exchange: normalizedExchange, tradingsymbol: normalizedSymbol },
            { $set: { symboltoken: repairedToken } },
            { upsert: false }
        );

        tokenRepairCooldown.set(repairKey, now + TOKEN_REPAIR_COOLDOWN_MS);
        log.warn("[MARKET_DATA_TOKEN_REPAIRED]", {
            exchange: normalizedExchange,
            tradingsymbol: normalizedSymbol,
            symboltoken: repairedToken,
        });
        return repairedToken;
    } catch (err: any) {
        const status = Number(err?.response?.status || 0);
        const isAuthOrForbidden = status === 401 || status === 403;
        tokenRepairCooldown.set(
            repairKey,
            now + (isAuthOrForbidden ? TOKEN_REPAIR_AUTH_COOLDOWN_MS : TOKEN_REPAIR_COOLDOWN_MS)
        );

        if (shouldLogWarning(`TOKEN_REPAIR_FAIL:${repairKey}`, 5 * 60 * 1000)) {
            log.warn("[MARKET_DATA_TOKEN_REPAIR_FAILED]", {
                exchange: normalizedExchange,
                tradingsymbol: normalizedSymbol,
                status: status || undefined,
                message: err?.message,
            });
        }
        return "";
    }
}

export async function getLiveIndexLtp(
    indexName: "NIFTY" | "BANKNIFTY" | "FINNIFTY" = "NIFTY",
    sessionHint?: SessionHint
): Promise<number> {
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
            const session = await resolveSessionForMarket(`market_data_index_${indexName}`, sessionHint);

            if (session && session.jwtToken) {
                const indexConfig: Record<string, { symbol: string, token: string }> = {
                    "NIFTY": { symbol: config.angelIndexSymbolNifty, token: config.angelIndexTokenNifty },
                    "BANKNIFTY": { symbol: config.angelIndexSymbolBankNifty, token: config.angelIndexTokenBankNifty },
                    "FINNIFTY": { symbol: config.angelIndexSymbolFinNifty, token: config.angelIndexTokenFinNifty }
                };
                const index = indexConfig[indexName];
                const sessionApiKey = await resolveSessionApiKey(session, `market_data_index_${indexName}`);
                if (!sessionApiKey) {
                    if (shouldLogWarning(`INDEX_APIKEY_MISSING:${session?.userId || "UNKNOWN"}:${session?.clientcode || "UNKNOWN"}:${indexName}`)) {
                        log.warn("[MARKET_DATA_APIKEY_MISSING]", {
                            context: "index",
                            indexName,
                            userId: String(session?.userId || ""),
                            clientcode: session?.clientcode || "",
                        });
                    }
                    return cached?.ltp || 0;
                }
                
                const decJwtToken = await ensureEncrypted(session, 'jwtToken', `market_data_index_val_${indexName}`);
                
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
                    const { ltp } = extractAngelLtp(resp);
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

export async function getInstrumentLtp(
    exchange: string,
    tradingsymbol: string,
    symboltoken: string,
    sessionHint?: SessionHint
): Promise<number> {
    const normalizedExchange = String(exchange || "").trim().toUpperCase();
    const normalizedSymbol = String(tradingsymbol || "").trim().toUpperCase();
    const requestedToken = String(symboltoken || "").trim();
    const isUpstox = requestedToken.includes("|") || normalizedExchange === "NSE_FO" || requestedToken.length > 20;

    let angelToken = requestedToken;
    if (!isUpstox) {
        const validation = await validateInstrumentFromMaster({
            exchange: normalizedExchange,
            tradingsymbol: normalizedSymbol,
            requestedToken,
            allowExpired: false,
        });

        if (!validation.valid || !validation.symboltoken) {
            if (shouldLogWarning(`INSTRUMENT_BLOCKED:${normalizedExchange}:${normalizedSymbol}`, 5 * 60 * 1000)) {
                log.warn("[MARKET_DATA_INSTRUMENT_BLOCKED]", {
                    exchange: normalizedExchange,
                    tradingsymbol: normalizedSymbol,
                    requestedToken: requestedToken || undefined,
                    reason: validation.reason || "INVALID_INSTRUMENT",
                    metadata: validation.metadata,
                });
            }
            const staleCacheKey = `${normalizedExchange}:${requestedToken}`;
            const stale = ltpCache.get(staleCacheKey);
            return stale?.ltp || 0;
        }

        angelToken = String(validation.symboltoken).trim();
    }

    const cacheKey = `${normalizedExchange}:${angelToken || requestedToken}`;
    const now = Date.now();
    const cached = ltpCache.get(cacheKey);

    if (cached && (now - cached.ts < CACHE_MS)) return cached.ltp;
    try {
        if (isUpstox) {
            const upstoxDoc = await UpstoxTokensModel.findOne({ accessToken: { $exists: true } }).sort({ updatedAt: -1 }).lean();
            if (upstoxDoc?.accessToken) {
                const apiResp = await getUpstoxAdapter().getLtp(upstoxDoc.accessToken, requestedToken);
                const data = apiResp?.data || {};
                let entry = data[requestedToken as keyof typeof data];
                if (!entry) {
                    const altKey = requestedToken.replace("|", ":");
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
                const session = await resolveSessionForMarket(
                    `market_data_instrument_${normalizedExchange}_${angelToken || requestedToken}`,
                    sessionHint
                );
                if (session && session.jwtToken) {
                    const sessionApiKey = await resolveSessionApiKey(
                        session,
                        `market_data_instrument_${normalizedExchange}_${angelToken || requestedToken}`
                    );
                    if (!sessionApiKey) {
                        if (shouldLogWarning(`INSTRUMENT_APIKEY_MISSING:${session?.userId || "UNKNOWN"}:${session?.clientcode || "UNKNOWN"}:${normalizedSymbol}`)) {
                            log.warn("[MARKET_DATA_APIKEY_MISSING]", {
                                context: "instrument",
                                exchange: normalizedExchange,
                                tradingsymbol: normalizedSymbol,
                                userId: String(session?.userId || ""),
                                clientcode: session?.clientcode || "",
                            });
                        }
                        return cached?.ltp || 0;
                    }
                    
                    const decJwtToken = await ensureEncrypted(
                        session,
                        'jwtToken',
                        `market_data_instrument_val_${angelToken || requestedToken}`
                    );
                    let jwtForRequest = decJwtToken;
                    
                    let tokenForRequest = angelToken || requestedToken;
                    let resp = await getLtpInternal(
                        jwtForRequest,
                        normalizedExchange,
                        normalizedSymbol,
                        tokenForRequest,
                        sessionApiKey
                    );
                    if (isInvalidTokenResponse(resp)) {
                        try {
                            const refreshed = await refreshAngelSession(session);
                            jwtForRequest = refreshed.jwtToken;
                            resp = await getLtpInternal(
                                jwtForRequest,
                                normalizedExchange,
                                normalizedSymbol,
                                tokenForRequest,
                                refreshed.apiKey
                            );
                        } catch (reErr) {
                            if (shouldLogWarning(`REFRESH_FAIL_SYMBOL:${session?.clientcode || "UNKNOWN"}:${normalizedSymbol}`)) {
                                log.warn(`Angel refresh failed for ${normalizedSymbol} LTP:`, reErr);
                            }
                        }
                    }

                    if (isSymbolCacheMissResponse(resp)) {
                        if (!ENABLE_LIVE_TOKEN_REPAIR) {
                            if (shouldLogWarning(`TOKEN_REPAIR_DISABLED:${normalizedExchange}:${normalizedSymbol}`, 10 * 60 * 1000)) {
                                log.warn("[MARKET_DATA_TOKEN_REPAIR_SKIPPED]", {
                                    reason: "TOKEN_REPAIR_DISABLED",
                                    exchange: normalizedExchange,
                                    tradingsymbol: normalizedSymbol,
                                });
                            }
                        } else if (isDataClientSession(session)) {
                            if (shouldLogWarning(`TOKEN_REPAIR_SKIPPED_DATA:${normalizedExchange}:${normalizedSymbol}`, 10 * 60 * 1000)) {
                                log.warn("[MARKET_DATA_TOKEN_REPAIR_SKIPPED]", {
                                    reason: "DATA_CLIENT_SESSION",
                                    exchange: normalizedExchange,
                                    tradingsymbol: normalizedSymbol,
                                    clientcode: String(session?.clientcode || ""),
                                });
                            }
                        } else {
                            const repairedToken = await attemptLiveTokenRepair(
                                String(session?.userId || getSystemDataScopeUserId()),
                                sessionApiKey,
                                jwtForRequest,
                                normalizedExchange,
                                normalizedSymbol
                            );
                            if (repairedToken && repairedToken !== tokenForRequest) {
                                tokenForRequest = repairedToken;
                                resp = await getLtpInternal(
                                    jwtForRequest,
                                    normalizedExchange,
                                    normalizedSymbol,
                                    tokenForRequest,
                                    sessionApiKey
                                );
                            }
                        }
                    }

                    if (resp && resp.status === 200 && resp.data) {
                        const parsed = extractAngelLtp(resp);
                        const ltp = parsed.ltp;

                        const tokenMismatch =
                            Boolean(parsed.token) &&
                            parsed.token !== String(tokenForRequest);
                        const symbolMismatch =
                            Boolean(parsed.symbol) &&
                            parsed.symbol !== normalizedSymbol;

                        if (tokenMismatch || symbolMismatch) {
                            if (shouldLogWarning(`LTP_MISMATCH:${normalizedExchange}:${normalizedSymbol}:${tokenForRequest}`)) {
                                log.error("[MARKET_DATA_LTP_MISMATCH]", {
                                    exchange: normalizedExchange,
                                    requestedSymbol: normalizedSymbol,
                                    requestedToken: tokenForRequest,
                                    brokerSymbol: parsed.symbol || undefined,
                                    brokerToken: parsed.token || undefined,
                                    raw: parsed.body,
                                });
                            }
                            return cached?.ltp || 0;
                        }

                        if (!Number.isNaN(ltp) && ltp > 0) {
                            ltpCache.set(cacheKey, { ltp, ts: now });
                            return ltp;
                        } else if (ltp === 0 && shouldLogWarning(`INSTRUMENT_ZERO:${normalizedSymbol}:${tokenForRequest}`)) {
                            log.warn(`[INSTRUMENT_ZERO_LTP] Received 0 for ${tradingsymbol}. Raw: ${JSON.stringify(resp.data)}`);
                        }
                    }
                    if (resp && isRateLimitError(resp)) {
                        cooldownUntil = now + 60000;
                        log.warn(`Instrument LTP Rate limited (${normalizedSymbol}). Cooling down 60s.`);
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
export async function getMultipleInstrumentsLtp(
    payload: Record<string, string[]>,
    sessionHint?: SessionHint
): Promise<Record<string, number>> {
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
            const session = await resolveSessionForMarket("market_data_batch_ltp", sessionHint);
            if (session && session.jwtToken) {
                const sessionApiKey = await resolveSessionApiKey(session, "market_data_batch_ltp");
                if (!sessionApiKey) {
                    if (shouldLogWarning(`BATCH_APIKEY_MISSING:${session?.userId || "UNKNOWN"}:${session?.clientcode || "UNKNOWN"}`)) {
                        log.warn("[MARKET_DATA_APIKEY_MISSING]", {
                            context: "batch",
                            userId: String(session?.userId || ""),
                            clientcode: session?.clientcode || "",
                        });
                    }
                    return results;
                }
                const decJwtToken = await ensureEncrypted(session, 'jwtToken', 'batch_ltp_val');
                
                const dynamicAdapter = getOrCreateUserAngelAdapter(
                    String(session?.userId || getSystemDataScopeUserId()),
                    sessionApiKey
                );
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
                            const tokenKey = String(token);
                            results[tokenKey] = finalLtp;
                            results[tokenKey.toLowerCase()] = finalLtp;
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

export async function getLiveNiftyLtp(sessionHint?: SessionHint): Promise<number> {
    return getLiveIndexLtp("NIFTY", sessionHint);
}
