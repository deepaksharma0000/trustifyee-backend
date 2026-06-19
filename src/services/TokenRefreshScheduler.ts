import AngelTokensModel from "../models/AngelTokens";
import User from "../models/User";
import log from "../utils/logger";
import redlock from "../utils/redlock";
import { recoverSessionByRefreshOrLogin } from "./AngelSessionLifecycleService";
import { sessionAuthority } from "./SessionAuthority";
import { ZerodhaSessionService } from "./ZerodhaSessionService";
import { ZerodhaAdapter } from "../adapters/ZerodhaAdapter";
// @ts-ignore — p-limit v2 default export
import pLimit from "p-limit";

const REFRESH_LOOKAHEAD_MS = 30 * 60 * 1000;
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

// CONCURRENCY GUARD: max 5 simultaneous refresh/login calls to Angel One.
// Prevents login storms that trigger AB1008 "maximum attempts exceeded" lockout.
const REFRESH_CONCURRENCY = Number(process.env.TOKEN_REFRESH_CONCURRENCY || "5");

export class TokenRefreshScheduler {
  private static started = false;

  static start() {
    if (this.started) return;
    this.started = true;

    setInterval(() => {
      this.tick().catch((err) => {
        log.error("[TokenRefreshScheduler] periodic tick failed", err);
      });
    }, REFRESH_INTERVAL_MS);

    this.tick().catch((err) => {
      log.error("[TokenRefreshScheduler] initial tick failed", err);
    });
  }

  static async tick() {
    const lock = await redlock.acquire(["lock:token-refresh-scheduler"], 120000).catch(() => null);
    if (!lock) return;

    const startedAt = Date.now();

    try {
      const now = new Date();
      const refreshBefore = new Date(now.getTime() + REFRESH_LOOKAHEAD_MS);

      // FIX: Only refresh sessions for users who are ACTIVE + BROKER_CONNECTED + TRADING_ENABLED.
      // Previously this fetched ALL sessions, including expired/inactive users, causing:
      //   1. Unnecessary login attempts → Angel One AB1008 lockout ("maximum attempts exceeded")
      //   2. Wasted resources on users who are not actively trading
      const activeUsers = await User.find({
        status: "active",
        broker_connected: true,
        trading_status: "enabled",
        broker: { $regex: /^angelone$/i },
      })
        .select("_id client_key")
        .lean();

      if (activeUsers.length === 0) {
        log.info("[TokenRefreshScheduler] No active Angel-connected users — skipping Angel refresh.");
      } else {
        const activeUserIds = activeUsers.map((u) => String(u._id));

        const sessions = await AngelTokensModel.find({
          userId: { $in: activeUserIds },
          refreshToken: { $exists: true, $ne: "" },
          $or: [
            { expiresAt: { $exists: false } },
            { expiresAt: null },
            { expiresAt: { $lte: refreshBefore } },
          ],
        })
          .sort({ updatedAt: 1 })
          .limit(100);

        if (sessions.length > 0) {
          log.info("[TokenRefreshScheduler] Refreshing sessions for active users", {
            activeUsers: activeUserIds.length,
            sessionsToRefresh: sessions.length,
          });

          const limit = pLimit(REFRESH_CONCURRENCY);

          const settled = await Promise.allSettled(
            sessions.map((session) =>
              limit(async () => {
                try {
                  const rotated = await sessionAuthority.rotateSession(String(session.userId), session.clientcode);
                  if (!rotated) {
                    return { clientcode: session.clientcode, status: "failed", reason: "Rotation workflow failed" };
                  }

                  return { clientcode: session.clientcode, status: "refreshed", mode: "REFRESH" };
                } catch (error: any) {
                  log.warn("[TokenRefreshScheduler] refresh failed", {
                    clientcode: session.clientcode,
                    userId: String(session.userId || ""),
                    message: error?.message,
                  });

                  return { clientcode: session.clientcode, status: "failed", reason: error?.message };
                }
              })
            )
          );

          const refreshed = settled.filter(
            (s) => s.status === "fulfilled" && (s.value as any)?.status === "refreshed"
          ).length;
          const failed = settled.filter(
            (s) => s.status === "fulfilled" && (s.value as any)?.status === "failed"
          ).length;

          log.info("[TokenRefreshScheduler] Angel tick complete", {
            scanned: sessions.length,
            refreshed,
            failed,
            durationMs: Date.now() - startedAt,
          });

          await this.refreshZerodhaSessions(limit);
          await this.expireStaleAliceSessions();
          return;
        }
      }

      const limit = pLimit(REFRESH_CONCURRENCY);
      await this.refreshZerodhaSessions(limit);
      await this.expireStaleAliceSessions();
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  private static async refreshZerodhaSessions(limit: ReturnType<typeof pLimit>) {
    const now = new Date();
    const refreshBefore = new Date(now.getTime() + REFRESH_LOOKAHEAD_MS);

    const zerodhaUsers = await User.find({
      status: "active",
      broker_connected: true,
      trading_status: "enabled",
      broker: { $regex: /^zerodha$/i },
      zerodha_connected: true,
      $or: [
        { zerodha_token_expiry: { $exists: false } },
        { zerodha_token_expiry: null },
        { zerodha_token_expiry: { $lte: refreshBefore } },
      ],
    })
      .select("_id user_name email outgoing_ip zerodha_token_expiry zerodha_connected zerodha_verified zerodha_access_token zerodha_api_key")
      .limit(100)
      .lean();

    if (zerodhaUsers.length === 0) return;

    log.info("[TokenRefreshScheduler] Validating Zerodha sessions", { count: zerodhaUsers.length });

    const settled = await Promise.allSettled(
      zerodhaUsers.map((user) =>
        limit(async () => {
          const userId = String(user._id);
          try {
            const fullUser = await User.findById(userId).select(
              "+zerodha_access_token +zerodha_api_key +zerodha_api_secret zerodha_user_id zerodha_connected zerodha_verified zerodha_token_expiry outgoing_ip"
            );
            if (!fullUser) return { userId, status: "failed", reason: "User not found" };

            const adapter = new ZerodhaAdapter(fullUser.outgoing_ip);
            await adapter.refreshSession(fullUser);
            await User.updateOne(
              { _id: userId },
              { $set: { zerodha_token_expiry: new Date(Date.now() + 24 * 60 * 60 * 1000) } }
            );
            return { userId, status: "refreshed" };
          } catch (error: any) {
            await ZerodhaSessionService.markDisconnected(userId, error?.message || "Session validation failed");
            return { userId, status: "failed", reason: error?.message };
          }
        })
      )
    );

    const refreshed = settled.filter(
      (s) => s.status === "fulfilled" && (s.value as any)?.status === "refreshed"
    ).length;
    const failed = settled.filter(
      (s) => s.status === "fulfilled" && (s.value as any)?.status === "failed"
    ).length;

    log.info("[TokenRefreshScheduler] Zerodha tick complete", { refreshed, failed });
  }

  /** Alice Blue has no refresh token — purge expired sessions and mark users disconnected. */
  private static async expireStaleAliceSessions() {
    const AliceTokensModel = require("../models/AliceTokens").default;
    const now = new Date();

    const expired = await AliceTokensModel.find({
      expiresAt: { $lte: now },
    })
      .select("userId clientcode")
      .lean();

    if (!expired.length) return;

    for (const row of expired) {
      await AliceTokensModel.deleteOne({ _id: row._id });
      if (row.userId) {
        await User.updateOne(
          { _id: row.userId, broker: "AliceBlue" },
          { broker_connected: false, broker_verified: false }
        );
      }
      log.warn("[TokenRefreshScheduler] Alice session expired — user must reconnect", {
        clientcode: row.clientcode,
        userId: row.userId,
      });
    }
  }
}
