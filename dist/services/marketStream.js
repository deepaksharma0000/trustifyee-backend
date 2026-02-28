"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startMarketStream = startMarketStream;
const ws_1 = require("ws");
const AngelOneAdapter_1 = require("../adapters/AngelOneAdapter");
const UpstoxAdapter_1 = require("../adapters/UpstoxAdapter");
const AngelTokens_1 = __importDefault(require("../models/AngelTokens"));
const UpstoxTokens_1 = __importDefault(require("../models/UpstoxTokens"));
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const MIN_FETCH_MS = 1500;
const DEFAULT_INTERVAL_MS = 3000;
const MAX_ITEMS = 20;
const quoteCache = new Map();
function isInvalidTokenResponse(resp) {
    const code = resp?.errorcode || resp?.errorCode;
    const msg = String(resp?.message || "").toLowerCase();
    return code === "AG8001" || msg.includes("invalid token");
}
async function refreshAngelSession(session, adapter) {
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
function startMarketStream(server) {
    const wss = new ws_1.Server({ server, path: "/ws/market" });
    wss.on("connection", (ws) => {
        const state = { intervalMs: DEFAULT_INTERVAL_MS, items: [] };
        const stopTimer = () => {
            if (state.timer) {
                clearInterval(state.timer);
                state.timer = undefined;
            }
        };
        const startTimer = () => {
            stopTimer();
            if (!state.items.length)
                return;
            if (config_1.config.disableLiveLtp) {
                ws.send(JSON.stringify({ type: "error", message: "Live market stream disabled for demo" }));
                return;
            }
            state.timer = setInterval(async () => {
                try {
                    // Fetch both sessions
                    const [angelSession, upstoxSession] = await Promise.all([
                        AngelTokens_1.default.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 }).lean(),
                        UpstoxTokens_1.default.findOne({ accessToken: { $exists: true } }).sort({ updatedAt: -1 }).lean()
                    ]);
                    if (!angelSession?.jwtToken && !upstoxSession?.accessToken) {
                        // log.warn("No active broker session found for WS stream");
                        return;
                    }
                    let jwtToken = angelSession?.jwtToken;
                    let upstoxToken = upstoxSession?.accessToken;
                    const results = [];
                    const now = Date.now();
                    const limitedItems = state.items.slice(0, MAX_ITEMS);
                    // Batching for AngelOne
                    const angelItems = limitedItems.filter(item => !item.symboltoken.includes("|") && item.symboltoken.length <= 20);
                    const upstoxItems = limitedItems.filter(item => item.symboltoken.includes("|") || item.symboltoken.length > 20);
                    // Handle AngelOne Batched
                    if (angelItems.length > 0 && jwtToken) {
                        const angelAdapter = new AngelOneAdapter_1.AngelOneAdapter();
                        try {
                            const exchangeTokens = {};
                            angelItems.forEach(item => {
                                if (!exchangeTokens[item.exchange])
                                    exchangeTokens[item.exchange] = [];
                                exchangeTokens[item.exchange].push(item.symboltoken);
                            });
                            let resp = await angelAdapter.getMarketData(jwtToken, "FULL", exchangeTokens);
                            if (isInvalidTokenResponse(resp)) {
                                const refreshed = await refreshAngelSession(angelSession, angelAdapter);
                                jwtToken = refreshed.jwtToken;
                                resp = await angelAdapter.getMarketData(jwtToken, "FULL", exchangeTokens);
                            }
                            if (resp && resp.status === true && resp.data && resp.data.fetched) {
                                resp.data.fetched.forEach((data) => {
                                    const token = data.symbolToken;
                                    const ltp = Number(data.ltp || 0);
                                    const close = Number(data.close || ltp);
                                    const oi = Number(data.oi || data.openInterest || 0);
                                    const volume = Number(data.volume || data.tradeVolume || 0);
                                    let percentChange = Number(data.percentChange || 0);
                                    // Fallback: Calculate percentChange if it's 0 but there's a difference between ltp and close
                                    if (percentChange === 0 && ltp !== 0 && close !== 0 && ltp !== close) {
                                        percentChange = Number((((ltp - close) / close) * 100).toFixed(2));
                                    }
                                    quoteCache.set(token, { ltp, oi, ts: Date.now(), volume, percentChange });
                                    results.push({
                                        symboltoken: token,
                                        ltp,
                                        oi,
                                        volume,
                                        percentChange,
                                        ts: Date.now()
                                    });
                                });
                            }
                        }
                        catch (err) {
                            logger_1.log.error("Angel Market Data Batch failed:", err);
                        }
                    }
                    // Handle Upstox (keeping it simple for now as it's secondary)
                    if (upstoxItems.length > 0 && upstoxToken) {
                        const upstoxAdapter = new UpstoxAdapter_1.UpstoxAdapter();
                        for (const item of upstoxItems) {
                            try {
                                const resp = await upstoxAdapter.getLtp(upstoxToken, item.symboltoken);
                                const data = resp?.data || {};
                                let entry = data[item.symboltoken];
                                if (!entry) {
                                    const altKey = item.symboltoken.replace("|", ":");
                                    entry = data[altKey];
                                }
                                const ltp = Number(entry?.last_price || 0);
                                const oi = Number(entry?.oi || 0);
                                const volume = Number(entry?.volume || 0);
                                const percentChange = Number(entry?.cp || 0); // Upstox often uses cp for change percent
                                quoteCache.set(item.symboltoken, { ltp, oi, ts: Date.now(), volume, percentChange });
                                results.push({
                                    symboltoken: item.symboltoken,
                                    tradingsymbol: item.tradingsymbol,
                                    ltp,
                                    oi,
                                    volume,
                                    percentChange,
                                    ts: Date.now()
                                });
                            }
                            catch (err) { }
                        }
                    }
                    if (results.length > 0) {
                        ws.send(JSON.stringify({ type: "tick", items: results }));
                    }
                }
                catch (err) {
                    // ws.send(JSON.stringify({ type: "error", message: err.message || String(err) }));
                }
            }, Math.max(state.intervalMs, DEFAULT_INTERVAL_MS));
        };
        ws.on("message", (raw) => {
            try {
                const msg = JSON.parse(String(raw));
                if (msg?.type === "subscribe" && Array.isArray(msg.items)) {
                    state.items = msg.items;
                    state.intervalMs =
                        typeof msg.intervalMs === "number"
                            ? Math.max(msg.intervalMs, DEFAULT_INTERVAL_MS)
                            : state.intervalMs;
                    startTimer();
                }
                if (msg?.type === "unsubscribe") {
                    state.items = [];
                    stopTimer();
                }
            }
            catch (err) {
                ws.send(JSON.stringify({ type: "error", message: "Invalid message" }));
            }
        });
        ws.on("close", () => {
            stopTimer();
        });
    });
    logger_1.log.info("Market stream WS running on /ws/market");
}
