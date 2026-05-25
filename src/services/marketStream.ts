// src/services/marketStream.ts
import { Server as WebSocketServer, WebSocket } from "ws";
import Redis from "ioredis";
import { config } from "../config";
import log from "../utils/logger";
import { tickEngineService } from "./TickEngineService";
import { redisBullConnection } from "../utils/redis";
import UpstoxTokensModel from "../models/UpstoxTokens";
import { getUpstoxAdapter } from "../utils/upstox";
import { isPlausibleLtp } from "../utils/price";

type QuoteRequestItem = {
  exchange: string;
  tradingsymbol: string;
  symboltoken: string;
};

const DEFAULT_INTERVAL_MS = 3000;
const MAX_ITEMS = 50;

// Dynamic quote cache for other services
export const quoteCache = new Map<
  string,
  { ltp: number; oi: number | null; ts: number; volume?: number; percentChange?: number }
>();

export function startMarketStream(server: any) {
  const wss = new WebSocketServer({ server, path: "/ws/market" });
  log.info("Event-Driven Market stream WS running on /ws/market");

  wss.on("connection", (ws: WebSocket) => {
    let subRedis: Redis | null = null;
    let upstoxTimer: NodeJS.Timeout | null = null;
    let activeAngelSubs: QuoteRequestItem[] = [];
    let activeUpstoxSubs: QuoteRequestItem[] = [];

    const cleanup = () => {
      // 1. Terminate Redis Pub/Sub client
      if (subRedis) {
        subRedis.disconnect();
        subRedis = null;
      }

      // 2. Unsubscribe active tokens from the master Tick Engine
      activeAngelSubs.forEach((item) => {
        tickEngineService.unsubscribe(item.exchange, item.symboltoken);
      });
      activeAngelSubs = [];

      // 3. Clear Upstox secondary poll timer
      if (upstoxTimer) {
        clearInterval(upstoxTimer);
        upstoxTimer = null;
      }
      activeUpstoxSubs = [];
    };

    const handleSubscribe = async (items: QuoteRequestItem[]) => {
      cleanup();

      const limitedItems = items.slice(0, MAX_ITEMS);

      // Separate primary AngelOne items from secondary Upstox items
      const angelItems = limitedItems.filter(
        (item) => !item.symboltoken.includes("|") && item.symboltoken.length <= 20
      );
      const upstoxItems = limitedItems.filter(
        (item) => item.symboltoken.includes("|") || item.symboltoken.length > 20
      );

      activeAngelSubs = angelItems;
      activeUpstoxSubs = upstoxItems;

      // --- 1. SET UP ANGELONE EVENT-DRIVEN SUBSCRIPTIONS ---
      if (angelItems.length > 0) {
        subRedis = new Redis(redisBullConnection as any);
        const channels: string[] = [];
        const initialTicks: any[] = [];

        // Resolve channels and query Redis for immediate cached LTP values
        for (const item of angelItems) {
          const exName = item.exchange.toUpperCase().trim();
          const channel = `ticks:${exName}:${item.symboltoken}`.toUpperCase();
          channels.push(channel);

          // Register with master system Tick Engine
          tickEngineService.subscribe(item.exchange, item.symboltoken);

          // Proactively fetch cached LTP to prevent blackouts
          const cachedLtp = await subRedis.get(`LTP:${exName}:${item.symboltoken}`);
          if (cachedLtp) {
            const ltpNum = Number(cachedLtp);
            if (!isPlausibleLtp(exName, ltpNum)) {
              await subRedis.del(`LTP:${exName}:${item.symboltoken}`);
              log.warn("[MarketStream] Dropped implausible cached LTP", {
                exchange: exName,
                symboltoken: item.symboltoken,
                ltp: ltpNum,
              });
              continue;
            }
            quoteCache.set(item.symboltoken, { ltp: ltpNum, oi: 0, ts: Date.now() });
            initialTicks.push({
              symboltoken: item.symboltoken,
              ltp: ltpNum,
              oi: 0,
              volume: 0,
              percentChange: 0,
              ts: Date.now(),
            });
          }
        }

        // Push initial cache hits instantly
        if (initialTicks.length > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "tick", items: initialTicks }));
        }

        // Subscribe to real-time tick channel multicasts
        subRedis.subscribe(...channels);

        subRedis.on("message", (channel, message) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          try {
            const parsed = JSON.parse(message);
            const exchange = String(parsed.exchange || "").toUpperCase();
            const ltp = Number(parsed.ltp || 0);
            if (!isPlausibleLtp(exchange, ltp)) {
              log.warn("[MarketStream] Dropped implausible live LTP", {
                exchange,
                token: parsed.token,
                ltp,
              });
              return;
            }
            
            // Standardize cache entry
            quoteCache.set(parsed.token, {
              ltp,
              oi: 0,
              ts: parsed.timestamp,
            });

            // Standardize format back to frontend contract
            const tick = {
              symboltoken: parsed.token,
              ltp,
              oi: 0,
              volume: 0,
              percentChange: 0,
              ts: parsed.timestamp,
            };

            ws.send(JSON.stringify({ type: "tick", items: [tick] }));
          } catch (err: any) {
            log.error("[MarketStream] Redis Tick Forwarding failed:", err.message);
          }
        });
      }

      // --- 2. SET UP UPSTOX SECONDARY POLLING (Isolated Secondary Fallback) ---
      if (upstoxItems.length > 0) {
        const upstoxAdapter = getUpstoxAdapter();
        
        const executeUpstoxPoll = async () => {
          try {
            const upstoxSession = await UpstoxTokensModel.findOne({ accessToken: { $exists: true } })
              .sort({ updatedAt: -1 })
              .lean();

            if (!upstoxSession?.accessToken) return;

            const results: any[] = [];
            for (const item of upstoxItems) {
              try {
                const resp = await upstoxAdapter.getLtp(upstoxSession.accessToken, item.symboltoken);
                const data = resp?.data || {};
                let entry = data[item.symboltoken as keyof typeof data];
                if (!entry) {
                  const altKey = item.symboltoken.replace("|", ":");
                  entry = data[altKey as keyof typeof data];
                }
                const ltp = Number(entry?.last_price || 0);
                const oi = Number(entry?.oi || 0);
                const volume = Number(entry?.volume || 0);
                const percentChange = Number(entry?.cp || 0);

                quoteCache.set(item.symboltoken, { ltp, oi, ts: Date.now(), volume, percentChange });
                results.push({
                  symboltoken: item.symboltoken,
                  tradingsymbol: item.tradingsymbol,
                  ltp,
                  oi,
                  volume,
                  percentChange,
                  ts: Date.now(),
                });
              } catch (err) {}
            }

            if (results.length > 0 && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "tick", items: results }));
            }
          } catch (err: any) {
            log.error("[MarketStream] Upstox Polling failure:", err.message);
          }
        };

        // Trigger immediate first fetch and start polling interval
        await executeUpstoxPoll();
        upstoxTimer = setInterval(executeUpstoxPoll, DEFAULT_INTERVAL_MS);
      }
    };

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.type === "subscribe" && Array.isArray(msg.items)) {
          await handleSubscribe(msg.items);
        }
        if (msg?.type === "unsubscribe") {
          cleanup();
        }
      } catch (err: any) {
        ws.send(JSON.stringify({ type: "error", message: "Invalid payload format" }));
      }
    });

    ws.on("close", () => {
      cleanup();
    });
  });
}
