import { Server as WebSocketServer, WebSocket } from "ws";
import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import { UpstoxAdapter } from "../adapters/UpstoxAdapter";
import AngelTokensModel from "../models/AngelTokens";
import UpstoxTokensModel from "../models/UpstoxTokens";
import { config } from "../config";
import { log } from "../utils/logger";
import { encrypt, decrypt } from "../utils/encryption";

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
  const code = resp?.errorcode || resp?.errorCode;
  const msg = String(resp?.message || "").toLowerCase();
  return code === "AG8001" || msg.includes("invalid token");
}

async function refreshAngelSession(session: any, adapter: AngelOneAdapter) {
  if (!session?.refreshToken) {
    throw new Error("Angel refreshToken missing. Please login again.");
  }
  const decRefreshToken = decrypt(session.refreshToken);
  const resp = await adapter.generateTokensUsingRefresh(decRefreshToken);
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
    { 
      jwtToken: encrypt(jwtToken), 
      refreshToken: encrypt(refreshToken), 
      feedToken: encrypt(feedToken), 
      expiresAt: undefined 
    },
    { new: true }
  ).lean();
  return { jwtToken };
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

          // Handle AngelOne Batched
          if (angelItems.length > 0 && jwtToken) {
            const sessionApiKey = angelSession.apiKey ? decrypt(angelSession.apiKey) : config.angelApiKey;
            const angelAdapter = new AngelOneAdapter(sessionApiKey);
            try {
              const exchangeTokens: Record<string, string[]> = {};
              angelItems.forEach(item => {
                if (!exchangeTokens[item.exchange]) exchangeTokens[item.exchange] = [];
                exchangeTokens[item.exchange].push(item.symboltoken);
              });

              let resp = await angelAdapter.getMarketData(jwtToken, "FULL", exchangeTokens);

              if (isInvalidTokenResponse(resp)) {
                log.info(`[MarketStream] Token invalid for ${angelSession.clientcode}, refreshing...`);
                const refreshed = await refreshAngelSession(angelSession, angelAdapter);
                jwtToken = refreshed.jwtToken;
                resp = await angelAdapter.getMarketData(jwtToken, "FULL", exchangeTokens);
              }

              if (resp && resp.status === true && resp.data && resp.data.fetched) {
                resp.data.fetched.forEach((data: any) => {
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

                  quoteCache.set(token, { ltp, oi, ts: Date.now(), volume, percentChange } as any);
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
            } catch (err) {
              log.error("Angel Market Data Batch failed:", err);
            }
          }

          // Handle Upstox (keeping it simple for now as it's secondary)
          if (upstoxItems.length > 0 && upstoxToken) {
            const upstoxAdapter = new UpstoxAdapter();
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
