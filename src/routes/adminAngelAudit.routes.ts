import express from "express";
import crypto from "crypto";
import { auth, adminAuth } from "../middleware/auth.middleware";
import User from "../models/User";
import AngelTokensModel from "../models/AngelTokens";
import { decrypt, ensureEncrypted } from "../utils/encryption";
import { apiKeyFingerprint } from "../utils/apiKeyRouteBinding";
import { config } from "../config";
import { tickEngineService } from "../services/TickEngineService";
import { getSystemDataScopeUserId } from "../services/AngelAdapterRegistry";

const router = express.Router();

function hashApiKey(apiKey: string): string {
  if (!apiKey) return "EMPTY";
  return crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function ageMinutes(from?: Date | null): number | null {
  if (!from) return null;
  const ms = Date.now() - new Date(from).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 60_000);
}

/**
 * GET /api/admin/angel-audit
 * Per-user Angel One session health for production verification.
 */
router.get("/angel-audit", auth, adminAuth, async (_req, res) => {
  try {
    const users = await User.find({ broker: { $regex: /^angelone$/i } })
      .select(
        "user_name email client_key api_key broker_connected broker_verified requiresReconnect updated_at created_at"
      )
      .lean();

    const userIds = users.map((u) => u._id);
    const tokens = await AngelTokensModel.find({ userId: { $in: userIds } }).lean();
    const tokenByUserClient = new Map<string, any>();
    for (const t of tokens) {
      tokenByUserClient.set(`${String(t.userId)}:${String(t.clientcode).toUpperCase()}`, t);
    }

    const rows = await Promise.all(
      users.map(async (user) => {
        const userId = String(user._id);
        let clientCode = "";
        try {
          if (user.client_key) {
            clientCode = (await ensureEncrypted(user as any, "client_key", `audit_${userId}`)).toUpperCase();
          }
        } catch {
          clientCode = "";
        }

        const tokenDoc = clientCode
          ? tokenByUserClient.get(`${userId}:${clientCode}`)
          : tokens.find((t) => String(t.userId) === userId);

        let apiKeyPlain = "";
        try {
          if (user.api_key) {
            apiKeyPlain = await ensureEncrypted(user as any, "api_key", `audit_api_${userId}`);
          } else if (tokenDoc?.apiKey) {
            apiKeyPlain = decrypt(String(tokenDoc.apiKey));
          }
        } catch {
          apiKeyPlain = "";
        }

        const tokenUpdatedAt = tokenDoc?.updatedAt ? new Date(tokenDoc.updatedAt) : null;
        const refreshPresent = Boolean(tokenDoc?.refreshToken);
        const jwtPresent = Boolean(tokenDoc?.jwtToken);
        const feedPresent = Boolean(tokenDoc?.feedToken);

        return {
          userId,
          userName: user.user_name || null,
          email: user.email || null,
          clientCode: clientCode || tokenDoc?.clientcode || null,
          apiKeyHash: hashApiKey(apiKeyPlain),
          apiKeyFingerprint: apiKeyPlain ? apiKeyFingerprint(apiKeyPlain) : "EMPTY",
          tokenAgeMinutes: ageMinutes(tokenUpdatedAt),
          refreshAgeMinutes: refreshPresent ? ageMinutes(tokenUpdatedAt) : null,
          feedTokenPresent: feedPresent,
          jwtTokenPresent: jwtPresent,
          refreshTokenPresent: refreshPresent,
          brokerConnected: Boolean(user.broker_connected),
          brokerVerified: Boolean(user.broker_verified),
          requiresReconnect: Boolean((user as any).requiresReconnect),
          lastLogin: tokenUpdatedAt ? tokenUpdatedAt.toISOString() : null,
          tokenExpiresAt: tokenDoc?.expiresAt ? new Date(tokenDoc.expiresAt).toISOString() : null,
        };
      })
    );

    return res.json({
      status: true,
      count: rows.length,
      perUserApiKeyMode: true,
      platformKeyForUserTrading: false,
      users: rows,
    });
  } catch (err: any) {
    return res.status(500).json({ status: false, error: err?.message || "Audit failed" });
  }
});

/**
 * GET /api/admin/system-data-audit
 * Health of the isolated market-data account (TickEngine / websocket feed).
 */
router.get("/system-data-audit", auth, adminAuth, async (_req, res) => {
  try {
    const dataUserId = getSystemDataScopeUserId();
    const dataClientCode = String(config.dataClientCode || "").trim();

    const tokenDoc = await AngelTokensModel.findOne({
      userId: dataUserId,
      clientcode: dataClientCode,
    })
      .sort({ updatedAt: -1 })
      .lean();

    const feedSnapshot = tickEngineService.getSystemDataAuditSnapshot();
    const tokenUpdatedAt = (tokenDoc as any)?.updatedAt ? new Date((tokenDoc as any).updatedAt) : null;

    return res.json({
      status: true,
      dataUserId,
      dataClientCode: dataClientCode || null,
      dataApiKeyConfigured: Boolean(String(config.dataApiKey || "").trim()),
      dataApiKeyFingerprint: config.dataApiKey ? apiKeyFingerprint(config.dataApiKey) : "EMPTY",
      tokenAgeMinutes: ageMinutes(tokenUpdatedAt),
      jwtTokenPresent: Boolean(tokenDoc?.jwtToken),
      feedTokenPresent: Boolean(tokenDoc?.feedToken),
      refreshTokenPresent: Boolean(tokenDoc?.refreshToken),
      websocketConnected: feedSnapshot.websocketConnected,
      marketFeedStatus: feedSnapshot.marketFeedStatus,
      lastRefresh: feedSnapshot.lastSessionRefresh || (tokenUpdatedAt ? tokenUpdatedAt.toISOString() : null),
      lastMessageAgeMs: feedSnapshot.lastMessageAgeMs,
      activeSubscriptions: feedSnapshot.activeSubscriptions,
      reconnectAttempts: feedSnapshot.reconnectAttempts,
      isDegraded: feedSnapshot.isDegraded,
      currentStreamUrl: feedSnapshot.currentStreamUrl,
      metrics: feedSnapshot.metrics,
      tradingBlockedForDataAccount: true,
    });
  } catch (err: any) {
    return res.status(500).json({ status: false, error: err?.message || "System data audit failed" });
  }
});

export default router;
