// src/services/UserSocketService.ts
// FIX #1 — Dedicated User Socket Registry (per-user WebSocket mapping)
import { WebSocket } from "ws";
import log from "../utils/logger";
import jwt, { JwtPayload } from "jsonwebtoken";

const USER_ACCESS_SECRET = process.env.USER_ACCESS_SECRET || "user_access_secret_123";
const ADMIN_ACCESS_SECRET = process.env.ADMIN_ACCESS_SECRET || "admin_access_secret_123";

/**
 * Map<userId, WebSocket>
 * Keeps track of ONE active socket per user.
 * If user reconnects, old socket is replaced.
 */
const userSockets = new Map<string, WebSocket>();

/**
 * Extract userId from a JWT token (tries admin secret first, then user secret).
 * Returns null if token is invalid or expired.
 */
export function extractUserIdFromToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, ADMIN_ACCESS_SECRET) as JwtPayload;
    if (decoded?.user_id) return decoded.user_id;
  } catch (_) {}

  try {
    const decoded = jwt.verify(token, USER_ACCESS_SECRET) as JwtPayload;
    if (decoded?.user_id) return decoded.user_id;
  } catch (_) {}

  return null;
}

/**
 * Register a WebSocket connection for a user.
 * Called when a user connects to /ws/signals.
 */
export function registerUserSocket(userId: string, ws: WebSocket): void {
  // Close old socket if any
  const existing = userSockets.get(userId);
  if (existing && existing.readyState === WebSocket.OPEN) {
    existing.close();
  }
  userSockets.set(userId, ws);
  log.info(`[UserSocket] User ${userId} connected. Total connected: ${userSockets.size}`);
}

/**
 * Remove a user's socket on disconnect.
 */
export function removeUserSocket(userId: string): void {
  userSockets.delete(userId);
  log.info(`[UserSocket] User ${userId} disconnected. Total connected: ${userSockets.size}`);
}

/**
 * Broadcast a payload to a specific user.
 * Returns true if delivered, false if user not connected.
 */
export function broadcastToUser(userId: string, payload: object): boolean {
  const ws = userSockets.get(String(userId));
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

/**
 * Broadcast a payload to ALL connected users.
 * Useful for market-wide signals.
 */
export function broadcastToAllUsers(payload: object): number {
  let count = 0;
  const msg = JSON.stringify(payload);
  for (const [, ws] of userSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
      count++;
    }
  }
  return count;
}

/**
 * Get count of currently connected users.
 */
export function getConnectedUserCount(): number {
  return userSockets.size;
}
