import { Server as WebSocketServer, WebSocket } from "ws";
import log from "../utils/logger";
import {
  extractUserIdFromToken,
  registerUserSocket,
  removeUserSocket,
} from "./UserSocketService";

const HEARTBEAT_INTERVAL_MS = 25000;
const SIGNAL_STREAM_PATHS = new Set([
  "/ws/signals",
  "/ws/signal",
  "/ws/user-signals",
  "/api/ws/signals",
  "/api/ws/signal",
  "/api/ws/user-signals",
]);

type SocketTokenMeta = {
  token: string;
  source: string;
};

function maybeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function normalizeToken(raw: string): string {
  let token = maybeDecode(String(raw || "").trim().replace(/^['"]|['"]$/g, ""));
  token = token.replace(/^authorization\s*:\s*/i, "");
  token = token.replace(/^bearer\s+/i, "");
  token = token.replace(/^token\s*[:=]?\s*/i, "");
  return token.trim();
}

function looksLikeJwt(value: string): boolean {
  return value.split(".").length === 3;
}

function extractTokenFromCookies(cookieHeader: string): string {
  const cookieText = String(cookieHeader || "");
  if (!cookieText) return "";

  const allowedNames = new Set(["token", "access_token", "x-access-token", "auth_token", "jwt"]);
  const parts = cookieText.split(";").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    const name = part.slice(0, eqIdx).trim().toLowerCase();
    if (!allowedNames.has(name)) continue;
    const value = normalizeToken(part.slice(eqIdx + 1));
    if (value) return value;
  }
  return "";
}

function extractTokenFromProtocols(protocolHeader: string): string {
  const parts = String(protocolHeader || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  for (let i = 0; i < parts.length; i += 1) {
    const current = parts[i];
    const currentLower = current.toLowerCase();
    const next = i + 1 < parts.length ? parts[i + 1] : "";

    if ((currentLower === "bearer" || currentLower === "token" || currentLower === "authorization") && next) {
      const paired = normalizeToken(next);
      if (paired) return paired;
    }

    const normalizedCurrent = normalizeToken(current);
    if (normalizedCurrent && looksLikeJwt(normalizedCurrent)) {
      return normalizedCurrent;
    }
  }

  return "";
}

function getSignalPath(req: any): string {
  try {
    const url = new URL(req?.url || "/", `http://${req?.headers?.host || "localhost"}`);
    return url.pathname || "/";
  } catch {
    return String(req?.url || "/").split("?")[0] || "/";
  }
}

function normalizePath(pathname: string): string {
  if (!pathname) return "/";
  if (pathname.length > 1) {
    return pathname.replace(/\/+$/, "");
  }
  return pathname;
}

function isSignalStreamPath(pathname: string): boolean {
  return SIGNAL_STREAM_PATHS.has(normalizePath(pathname));
}

function extractSocketToken(req: any): SocketTokenMeta {
  let queryToken = "";
  try {
    const url = new URL(req?.url || "", `http://${req?.headers?.host || "localhost"}`);
    queryToken =
      normalizeToken(url.searchParams.get("token") || "") ||
      normalizeToken(url.searchParams.get("access_token") || "") ||
      normalizeToken(url.searchParams.get("x-access-token") || "") ||
      normalizeToken(url.searchParams.get("authorization") || "") ||
      normalizeToken(url.searchParams.get("authToken") || "");
  } catch {
    queryToken = "";
  }

  const authHeader = normalizeToken(String(req?.headers?.authorization || ""));
  const xAccessTokenHeader = normalizeToken(String(req?.headers?.["x-access-token"] || ""));
  const protocolToken = extractTokenFromProtocols(String(req?.headers?.["sec-websocket-protocol"] || ""));
  const cookieToken = extractTokenFromCookies(String(req?.headers?.cookie || ""));

  if (queryToken) return { token: queryToken, source: "query" };
  if (authHeader) return { token: authHeader, source: "authorization-header" };
  if (xAccessTokenHeader) return { token: xAccessTokenHeader, source: "x-access-token-header" };
  if (protocolToken) return { token: protocolToken, source: "sec-websocket-protocol" };
  if (cookieToken) return { token: cookieToken, source: "cookie" };

  return { token: "", source: "none" };
}

export function startSignalStream(server: any): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: any, socket: any, head: any) => {
    const path = getSignalPath(req);
    if (!isSignalStreamPath(path)) {
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket, req: any) => {
    const tokenMeta = extractSocketToken(req);
    const token = tokenMeta.token;

    if (!token) {
      log.warn("[SignalStream] Socket rejected: missing auth token", {
        path: req?.url,
        hasAuthorizationHeader: Boolean(req?.headers?.authorization),
        hasXAccessTokenHeader: Boolean(req?.headers?.["x-access-token"]),
        hasProtocolHeader: Boolean(req?.headers?.["sec-websocket-protocol"]),
        hasCookieHeader: Boolean(req?.headers?.cookie),
      });
      ws.send(JSON.stringify({ type: "error", message: "AUTH_REQUIRED" }));
      ws.close();
      return;
    }

    const userId = extractUserIdFromToken(token);
    if (!userId) {
      log.warn("[SignalStream] Socket rejected: invalid token", {
        path: req?.url,
        tokenSource: tokenMeta.source,
      });
      ws.send(JSON.stringify({ type: "error", message: "INVALID_TOKEN" }));
      ws.close();
      return;
    }

    registerUserSocket(userId, ws);
    log.info("[SignalStream] User socket connected", {
      userId,
      tokenSource: tokenMeta.source,
      path: req?.url,
    });
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
      removeUserSocket(userId, ws);
    });

    ws.on("error", (err: any) => {
      log.error(`[SignalStream] WS error for user ${userId}:`, err?.message || err);
      clearInterval(heartbeat);
      removeUserSocket(userId, ws);
    });
  });

  log.info("Signal stream WS running", {
    paths: Array.from(SIGNAL_STREAM_PATHS),
  });
}
