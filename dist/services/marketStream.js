"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startMarketStream = startMarketStream;
const ws_1 = require("ws");
const AngelOneAdapter_1 = require("../adapters/AngelOneAdapter");
const AngelTokens_1 = __importDefault(require("../models/AngelTokens"));
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
    const adapter = new AngelOneAdapter_1.AngelOneAdapter();
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
                    const session = await AngelTokens_1.default.findOne({}).sort({ updatedAt: -1 }).lean();
                    if (!session?.jwtToken) {
                        ws.send(JSON.stringify({ type: "error", message: "AngelOne session missing" }));
                        return;
                    }
                    let jwtToken = session.jwtToken;
                    const results = [];
                    const now = Date.now();
                    const limitedItems = state.items.slice(0, MAX_ITEMS);
                    for (const item of limitedItems) {
                        const cached = quoteCache.get(item.symboltoken);
                        if (cached && now - cached.ts < MIN_FETCH_MS) {
                            results.push({
                                symboltoken: item.symboltoken,
                                tradingsymbol: item.tradingsymbol,
                                ltp: cached.ltp,
                                oi: cached.oi,
                                ts: cached.ts,
                                cached: true,
                            });
                            continue;
                        }
                        let resp = await adapter.getLtp(jwtToken, item.exchange, item.tradingsymbol, item.symboltoken);
                        if (isInvalidTokenResponse(resp)) {
                            const refreshed = await refreshAngelSession(session, adapter);
                            jwtToken = refreshed.jwtToken;
                            resp = await adapter.getLtp(jwtToken, item.exchange, item.tradingsymbol, item.symboltoken);
                        }
                        const data = resp?.data || {};
                        const ltp = Number(data.ltp || data.last_traded_price || 0);
                        const oi = data.openInterest ?? data.oi ?? data.open_interest ?? null;
                        quoteCache.set(item.symboltoken, { ltp, oi, ts: Date.now() });
                        results.push({
                            symboltoken: item.symboltoken,
                            tradingsymbol: item.tradingsymbol,
                            ltp,
                            oi,
                            ts: Date.now(),
                        });
                    }
                    ws.send(JSON.stringify({ type: "tick", items: results }));
                }
                catch (err) {
                    ws.send(JSON.stringify({ type: "error", message: err.message || String(err) }));
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
