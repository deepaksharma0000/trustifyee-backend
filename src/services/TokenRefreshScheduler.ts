import AngelTokensModel from "../models/AngelTokens";
import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import log from "../utils/logger";
import { ensureEncrypted, encrypt } from "../utils/encryption";
import redlock from "../utils/redlock";

const REFRESH_LOOKAHEAD_MS = 30 * 60 * 1000;
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

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

      const sessions = await AngelTokensModel.find({
        refreshToken: { $exists: true, $ne: "" },
        $or: [
          { expiresAt: { $exists: false } },
          { expiresAt: null },
          { expiresAt: { $lte: refreshBefore } },
        ],
      })
        .sort({ updatedAt: 1 })
        .limit(100);

      if (sessions.length === 0) {
        return;
      }

      const settled = await Promise.allSettled(
        sessions.map(async (session) => {
          try {
            const apiKey = await ensureEncrypted(session, "apiKey", `refresh_api_${session.clientcode}`);
            const refreshToken = await ensureEncrypted(
              session,
              "refreshToken",
              `refresh_rt_${session.clientcode}`
            );

            if (!apiKey || !refreshToken) {
              throw new Error("Missing apiKey or refreshToken");
            }

            const adapter = new AngelOneAdapter(apiKey);
            const refreshResp = await adapter.generateTokensUsingRefresh(refreshToken);
            const refreshData = refreshResp?.data?.data || refreshResp?.data;

            const newJwt = refreshData?.jwtToken || refreshData?.accessToken || refreshData?.token;
            const newRefresh = refreshData?.refreshToken || refreshToken;
            const newFeed = refreshData?.feedToken || refreshData?.websocketToken;

            if (!newJwt) {
              throw new Error("Refresh response missing jwt token");
            }

            await AngelTokensModel.updateOne(
              { _id: session._id },
              {
                $set: {
                  jwtToken: encrypt(newJwt),
                  refreshToken: encrypt(newRefresh),
                  feedToken: newFeed ? encrypt(newFeed) : undefined,
                  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
                },
              }
            );

            return { clientcode: session.clientcode, status: "refreshed" };
          } catch (error: any) {
            log.warn("[TokenRefreshScheduler] refresh failed", {
              clientcode: session.clientcode,
              userId: String(session.userId || ""),
              message: error?.message,
            });

            return { clientcode: session.clientcode, status: "failed" };
          }
        })
      );

      const refreshed = settled.filter(
        (s) => s.status === "fulfilled" && (s.value as any)?.status === "refreshed"
      ).length;
      const failed = settled.filter(
        (s) => s.status === "fulfilled" && (s.value as any)?.status === "failed"
      ).length;

      log.info("[TokenRefreshScheduler] tick complete", {
        scanned: sessions.length,
        refreshed,
        failed,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      await lock.release().catch(() => undefined);
    }
  }
}
