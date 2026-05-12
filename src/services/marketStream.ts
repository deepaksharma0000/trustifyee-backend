import { Server as WebSocketServer, WebSocket } from "ws";
import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import { UpstoxAdapter } from "../adapters/UpstoxAdapter";
import AngelTokensModel from "../models/AngelTokens";
import UpstoxTokensModel from "../models/UpstoxTokens";
import { config } from "../config";
import log from "../utils/logger";
import { getUpstoxAdapter } from "../utils/upstox";
import { decrypt } from "../utils/encryption";
import { recoverSessionByRefreshOrLogin } from "./AngelSessionLifecycleService";

type QuoteRequestItem = {
  exchange: string;
  tradingsymbol: string;
  symboltoken: string;
};

type ClientState = {
  intervalMs: number;
  items: QuoteRequestItem[];
  timer?: NodeJS.Timeout;
};

const MIN_FETCH_MS = 1500;
const DEFAULT_INTERVAL_MS = 3000;
const MAX_ITEMS = 50;
const quoteCache = new Map<
  string,
  { ltp: number; oi: number | null; ts: number }
>();

function isInvalidTokenResponse(resp: any) {
  const body = resp?.data || resp || {};
  const code = body?.errorCode || body?.errorcode || body?.code || resp?.errorCode || resp?.errorcode;
  const msg = String(body?.message || resp?.message || "").toLowerCase();
  return String(code || "").toUpperCase() === "AG8001" || msg.includes("invalid token");
}

async function refreshAngelSession(session: any, adapter: AngelOneAdapter) {
  const sessionDoc = await AngelTokensModel.findById(session?._id);
  if (!sessionDoc) {
    throw new Error("Session not found for refresh");
  }

  const recovery = await recoverSessionByRefreshOrLogin(sessionDoc, "market_stream");
  if (!recovery.ok || !recovery.jwtToken) {
    throw new Error(recovery.reason || "SESSION_RECOVERY_FAILED");
  }

  return { jwtToken: recovery.jwtToken };
}

export function startMarketStream(server: any) {
  const wss = new WebSocketServer({ server, path: "/ws/market" });

  wss.on("connection", (ws: WebSocket) => {
    const state: ClientState = { intervalMs: DEFAULT_INTERVAL_MS, items: [] };

    const stopTimer = () => {
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = undefined;
      }
    };

    const startTimer = () => {
      stopTimer();
      if (!state.items.length) return;
      state.timer = setInterval(async () => {
        try {
          // Fetch both sessions
          const [angelSession, upstoxSession] = await Promise.all([
            AngelTokensModel.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 }).lean() as any,
            UpstoxTokensModel.findOne({ accessToken: { $exists: true } }).sort({ updatedAt: -1 }).lean() as any
          ]);

          if (!angelSession?.jwtToken && !upstoxSession?.accessToken) {
            // log.warn("No active broker session found for WS stream");
            return;
          }

          let jwtToken = angelSession?.jwtToken;
          let upstoxToken = upstoxSession?.accessToken;
          const results: any[] = [];
          const now = Date.now();
          const limitedItems = state.items.slice(0, MAX_ITEMS);

          // Batching for AngelOne
          const angelItems = limitedItems.filter(item => !item.symboltoken.includes("|") && item.symboltoken.length <= 20);
          const upstoxItems = limitedItems.filter(item => item.symboltoken.includes("|") || item.symboltoken.length > 20);

          // Handle AngelOne Batched (Dynamic Resolution)
          if (angelItems.length > 0 && jwtToken) {
            const { DataFeedService } = require("./DataFeedService");
            try {
              const exchangeSymbols: Record<string, string[]> = {};
              const symbolToOrigItem: Record<string, any> = {};

              angelItems.forEach(item => {
                if (!exchangeSymbols[item.exchange]) exchangeSymbols[item.exchange] = [];
                exchangeSymbols[item.exchange].push(item.tradingsymbol);
                symbolToOrigItem[item.tradingsymbol] = item;
              });

              // 🛡️ Resolve Symbols to Tokens dynamically
              const resolvedMap: Record<string, string[]> = {};
              for (const ex in exchangeSymbols) {
                  const resolved = await DataFeedService.resolveSymbols(ex, exchangeSymbols[ex]);
                  const resolvedTokens = Object.values(resolved).filter(Boolean) as string[];
                  if (resolvedTokens.length > 0) {
                    resolvedMap[ex] = resolvedTokens;
                  }
              }

              if (Object.keys(resolvedMap).length === 0) {
                log.warn("[MarketStream] No tokens resolved for requested symbols.");
                return;
              }

              if (!angelSession.apiKey) throw new Error(`API Key missing for ${angelSession.clientcode}`);
              const sessionApiKey = decrypt(angelSession.apiKey, `market_stream_${angelSession.clientcode}`);
              const angelAdapter = new AngelOneAdapter(sessionApiKey);

              let resp = await angelAdapter.getMarketData(jwtToken, "FULL", resolvedMap);

              // 🔍 [DEBUG] RAW WS QUOTE RESPONSE
              if (resp?.data) {
                log.info(`[WS_QUOTE_DATA] Total fetched: ${resp.data.fetched?.length || 0}`);
              }

              if (isInvalidTokenResponse(resp)) {
                log.info(`[MarketStream] Token invalid for ${angelSession.clientcode}, refreshing...`);
                const refreshed = await refreshAngelSession(angelSession, angelAdapter);
                jwtToken = refreshed.jwtToken;
                resp = await angelAdapter.getMarketData(jwtToken, "FULL", resolvedMap);
              }

              if (resp && resp.status === 200 && resp.data && resp.data.fetched) {
                resp.data.fetched.forEach((data: any) => {
                  const token = data.symbolToken;
                  const ltp = Number(data.ltp || 0);
                  const lastPrice = Number(data.lastPrice || 0);
                  const close = Number(data.close || ltp || lastPrice || 0);
                  
                  // Fallback Logic
                  let finalLtp = ltp || lastPrice || close || 0;
                  
                  if (finalLtp === 0) {
                     log.error(`[WS_ZERO_LTP] Token ${token} still 0. Raw: ${JSON.stringify(data)}`);
                  }

                  const oi = Number(data.oi || data.openInterest || 0);
                  const volume = Number(data.volume || data.tradeVolume || 0);
                  let percentChange = Number(data.percentChange || 0);

                  // Fallback: Calculate percentChange if it's 0 but there's a difference between finalLtp and close
                  if (percentChange === 0 && finalLtp !== 0 && close !== 0 && finalLtp !== close) {
                    percentChange = Number((((finalLtp - close) / close) * 100).toFixed(2));
                  }

                  quoteCache.set(token, { ltp: finalLtp, oi, ts: Date.now(), volume, percentChange } as any);
                  results.push({
                    symboltoken: token,
                    ltp: finalLtp,
                    oi,
                    volume,
                    percentChange,
                    ts: Date.now()
                  });
                });
              }
            } catch (err) {
              log.error("Angel Market Data Batch failed:", err);
            }
          }

          // Handle Upstox (keeping it simple for now as it's secondary)
          if (upstoxItems.length > 0 && upstoxToken) {
            const upstoxAdapter = getUpstoxAdapter();
            for (const item of upstoxItems) {
              try {
                const resp = await upstoxAdapter.getLtp(upstoxToken, item.symboltoken);
                const data = resp?.data || {};
                let entry = data[item.symboltoken as keyof typeof data];
                if (!entry) {
                  const altKey = item.symboltoken.replace("|", ":");
                  entry = data[altKey as keyof typeof data];
                }
                const ltp = Number(entry?.last_price || 0);
                const oi = Number(entry?.oi || 0);
                const volume = Number(entry?.volume || 0);
                const percentChange = Number(entry?.cp || 0); // Upstox often uses cp for change percent

                quoteCache.set(item.symboltoken, { ltp, oi, ts: Date.now(), volume, percentChange } as any);
                results.push({
                  symboltoken: item.symboltoken,
                  tradingsymbol: item.tradingsymbol,
                  ltp,
                  oi,
                  volume,
                  percentChange,
                  ts: Date.now()
                });
              } catch (err) { }
            }
          }

          if (results.length > 0) {
            ws.send(JSON.stringify({ type: "tick", items: results }));
          }
        } catch (err: any) {
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
      } catch (err: any) {
        ws.send(JSON.stringify({ type: "error", message: "Invalid message" }));
      }
    });

    ws.on("close", () => {
      stopTimer();
    });
  });

  log.info("Market stream WS running on /ws/market");
}
