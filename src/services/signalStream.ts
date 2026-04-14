// src/services/signalStream.ts
// FIX #1 — Signal WebSocket Server on /ws/signals
// Handles: auth via JWT query param, signal push, ping, reconnect heartbeat

import { Server as WebSocketServer, WebSocket } from "ws";
import { log } from "../utils/logger";
import {
  extractUserIdFromToken,
  registerUserSocket,
  removeUserSocket,
} from "./UserSocketService";

const HEARTBEAT_INTERVAL_MS = 25000; // 25s ping to detect dead connections

export function startSignalStream(server: any): void {
  const wss = new WebSocketServer({ server, path: "/ws/signals" });

  wss.on("connection", (ws: WebSocket, req: any) => {
    // ── 1. Authenticate via token in query string ────────────────────────────
    //    Client connects: new WebSocket("ws://host/ws/signals?token=YOUR_JWT")
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const token = url.searchParams.get("token");

    if (!token) {
      ws.send(JSON.stringify({ type: "error", message: "AUTH_REQUIRED" }));
      ws.close();
      return;
    }

    const userId = extractUserIdFromToken(token);
    if (!userId) {
      ws.send(JSON.stringify({ type: "error", message: "INVALID_TOKEN" }));
      ws.close();
      return;
    }

    // ── 2. Register socket ───────────────────────────────────────────────────
    registerUserSocket(userId, ws);

    // Confirm connection to client
    ws.send(JSON.stringify({ type: "connected", userId, message: "Signal stream ready" }));

    // ── 3. Heartbeat (detect dead connections) ───────────────────────────────
    (ws as any).isAlive = true;
    ws.on("pong", () => { (ws as any).isAlive = true; });

    const heartbeat = setInterval(() => {
      if ((ws as any).isAlive === false) {
        log.warn(`[SignalStream] Heartbeat timeout for user ${userId}. Terminating.`);
        clearInterval(heartbeat);
        ws.terminate();
        return;
      }
      (ws as any).isAlive = false;
      ws.ping();
    }, HEARTBEAT_INTERVAL_MS);

    // ── 4. Message handler ───────────────────────────────────────────────────
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        // Client can send ping to keep alive
        if (msg?.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch (_) {
        // Ignore malformed messages
      }
    });

    // ── 5. Cleanup on disconnect ─────────────────────────────────────────────
    ws.on("close", () => {
      clearInterval(heartbeat);
      removeUserSocket(userId);
    });

    ws.on("error", (err) => {
      log.error(`[SignalStream] WS error for user ${userId}:`, err.message);
      clearInterval(heartbeat);
      removeUserSocket(userId);
    });
  });

  log.info("📡 Signal stream WS running on /ws/signals");
}
