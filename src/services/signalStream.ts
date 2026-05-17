import { Server as WebSocketServer, WebSocket } from "ws";
import log from "../utils/logger";
import {
  extractUserIdFromToken,
  registerUserSocket,
  removeUserSocket,
} from "./UserSocketService";

const HEARTBEAT_INTERVAL_MS = 25000;

function extractSocketToken(req: any): string {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const queryToken =
    url.searchParams.get("token") ||
    url.searchParams.get("access_token") ||
    url.searchParams.get("x-access-token") ||
    "";

  const authHeader = String(req?.headers?.authorization || "").trim();
  const bearerHeaderToken = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const rawHeaderToken = bearerHeaderToken ? "" : authHeader;
  const xAccessTokenHeader = String(req?.headers?.["x-access-token"] || "").trim();

  const protocolHeader = String(req?.headers?.["sec-websocket-protocol"] || "").trim();
  const protocolParts = protocolHeader
    .split(",")
    .map((p: string) => p.trim())
    .filter(Boolean);

  let protocolToken = "";
  if (protocolParts.length >= 2) {
    const first = protocolParts[0].toLowerCase();
    if (first === "bearer" || first === "token") {
      protocolToken = protocolParts[1];
    }
  } else if (protocolParts.length === 1 && protocolParts[0].split(".").length === 3) {
    protocolToken = protocolParts[0];
  }

  return queryToken || bearerHeaderToken || rawHeaderToken || xAccessTokenHeader || protocolToken;
}

export function startSignalStream(server: any): void {
  const wss = new WebSocketServer({ server, path: "/ws/signals" });

  wss.on("connection", (ws: WebSocket, req: any) => {
    const token = extractSocketToken(req);

    if (!token) {
      log.warn("[SignalStream] Socket rejected: missing auth token", {
        path: req?.url,
        hasAuthorizationHeader: Boolean(req?.headers?.authorization),
        hasXAccessTokenHeader: Boolean(req?.headers?.["x-access-token"]),
        hasProtocolHeader: Boolean(req?.headers?.["sec-websocket-protocol"]),
      });
      ws.send(JSON.stringify({ type: "error", message: "AUTH_REQUIRED" }));
      ws.close();
      return;
    }

    const userId = extractUserIdFromToken(token);
    if (!userId) {
      log.warn("[SignalStream] Socket rejected: invalid token", {
        path: req?.url,
      });
      ws.send(JSON.stringify({ type: "error", message: "INVALID_TOKEN" }));
      ws.close();
      return;
    }

    registerUserSocket(userId, ws);
    ws.send(JSON.stringify({ type: "connected", userId, message: "Signal stream ready" }));

    (ws as any).isAlive = true;
    ws.on("pong", () => {
      (ws as any).isAlive = true;
    });

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

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on("close", () => {
      clearInterval(heartbeat);
      removeUserSocket(userId);
    });

    ws.on("error", (err: any) => {
      log.error(`[SignalStream] WS error for user ${userId}:`, err?.message || err);
      clearInterval(heartbeat);
      removeUserSocket(userId);
    });
  });

  log.info("Signal stream WS running on /ws/signals");
}
