import User, { IUser } from "../models/User";
import { ZerodhaAdapter } from "../adapters/ZerodhaAdapter";
import { encrypt, decrypt } from "../utils/encryption";
import { config } from "../config";
import log from "../utils/logger";
import { AlertService } from "./AlertService";

const TOKEN_VALIDITY_MS = 24 * 60 * 60 * 1000;

export type ZerodhaConnectResult = {
  authUrl: string;
  state: string;
  apiKeySource: "user" | "platform";
};

export class ZerodhaSessionService {
  static resolveApiCredentials(user?: IUser | null, body?: { api_key?: string; api_secret?: string }) {
    const bodyKey = String(body?.api_key || "").trim();
    const bodySecret = String(body?.api_secret || "").trim();

    if (bodyKey && bodySecret) {
      return { apiKey: bodyKey, apiSecret: bodySecret, source: "user" as const };
    }

    const storedKey = user?.zerodha_api_key ? decrypt(user.zerodha_api_key) : "";
    const storedSecret = user?.zerodha_api_secret ? decrypt(user.zerodha_api_secret) : "";
    if (storedKey && storedSecret) {
      return { apiKey: storedKey, apiSecret: storedSecret, source: "user" as const };
    }

    const platformKey = config.zerodhaApiKey;
    const platformSecret = config.zerodhaApiSecret;
    if (platformKey && platformSecret) {
      return { apiKey: platformKey, apiSecret: platformSecret, source: "platform" as const };
    }

    throw new Error("Zerodha API credentials not configured. Provide api_key and api_secret or set ZERODHA_API_KEY on server.");
  }

  static buildOAuthState(userId: string, userType: string = "user") {
    return Buffer.from(JSON.stringify({ userId, userType, ts: Date.now() })).toString("base64url");
  }

  static parseOAuthState(state: string): { userId: string; userType: string } | null {
    try {
      const parsed = JSON.parse(Buffer.from(String(state || ""), "base64url").toString("utf8"));
      if (!parsed?.userId) return null;
      return { userId: String(parsed.userId), userType: String(parsed.userType || "user") };
    } catch {
      return null;
    }
  }

  static async prepareConnect(userId: string, userType: string, body?: { api_key?: string; api_secret?: string; client_key?: string }): Promise<ZerodhaConnectResult> {
    const UserModel = userType === "admin" ? require("../models/Admin").default : User;
    const profile = await UserModel.findById(userId);
    if (!profile) {
      throw new Error("User not found");
    }

    if (userType === "admin") {
      throw new Error("Zerodha connect is supported for client users only. Please login with your client account.");
    }

    const { apiKey, apiSecret, source } = this.resolveApiCredentials(profile, body);

    await UserModel.updateOne(
      { _id: userId },
      {
        $set: {
          broker: "Zerodha",
          ...(body?.api_key || body?.api_secret
            ? {
                zerodha_api_key: encrypt(apiKey),
                zerodha_api_secret: encrypt(apiSecret),
              }
            : {}),
        },
      }
    );

    if (body?.client_key && userType === "user") {
      await User.updateOne(
        { _id: userId },
        { $set: { client_key: encrypt(String(body.client_key).trim().toUpperCase()) } }
      );
    }

    const state = this.buildOAuthState(userId, userType);
    const adapter = new ZerodhaAdapter(profile.outgoing_ip);
    const authUrl = `${adapter.getAuthUrl(apiKey)}&redirect_params=${encodeURIComponent(`state=${state}`)}`;

    log.info("[ZERODHA_CONNECT] Auth URL generated", { userId, apiKeySource: source });

    return { authUrl, state, apiKeySource: source };
  }

  static async completeOAuth(requestToken: string, stateOrUserId?: string) {
    let userId = String(stateOrUserId || "").trim();
    let userType = "user";

    if (stateOrUserId && stateOrUserId.length > 20) {
      const parsed = this.parseOAuthState(stateOrUserId);
      if (parsed) {
        userId = parsed.userId;
        userType = parsed.userType;
      }
    }

    if (!requestToken || !userId) {
      throw new Error("request_token and user identity (state or user_id) are required");
    }

    const UserModel = userType === "admin" ? require("../models/Admin").default : User;
    const profile = await UserModel.findById(userId);
    if (!profile) {
      throw new Error("User not found");
    }

    if (userType === "admin") {
      throw new Error("Zerodha connect is supported for client users only. Admins should manage client broker connections.");
    }

    const { apiKey, apiSecret } = this.resolveApiCredentials(profile);
    const adapter = new ZerodhaAdapter(profile.outgoing_ip);
    const tokenResp = await adapter.exchangeToken(apiKey, apiSecret, requestToken);

    const sessionData = tokenResp?.data || tokenResp;
    const expiresAt = new Date(Date.now() + TOKEN_VALIDITY_MS);

    const updatePayload: Record<string, any> = {
      zerodha_user_id: sessionData.user_id,
      zerodha_api_key: encrypt(apiKey),
      zerodha_api_secret: encrypt(apiSecret),
      zerodha_request_token: encrypt(requestToken),
      zerodha_access_token: encrypt(sessionData.access_token),
      zerodha_refresh_token: sessionData.refresh_token ? encrypt(sessionData.refresh_token) : undefined,
      zerodha_token_expiry: expiresAt,
      zerodha_connected: true,
      zerodha_verified: true,
      broker: "Zerodha",
      broker_connected: true,
      broker_verified: true,
      trading_paused: false,
      consecutive_failures: 0,
    };

    if (userType === "user" && sessionData.user_id && !profile.client_key) {
      updatePayload.client_key = encrypt(String(sessionData.user_id).toUpperCase());
    }

    await UserModel.updateOne({ _id: userId }, { $set: updatePayload });

    log.info("[ZERODHA_OAUTH] Session established", {
      userId,
      kiteUserId: sessionData.user_id,
    });

    return {
      kiteUserId: sessionData.user_id,
      userName: sessionData.user_name,
      expiresAt,
    };
  }

  static isSessionExpired(user: IUser): boolean {
    if (!user.zerodha_token_expiry) return false;
    return new Date(user.zerodha_token_expiry).getTime() <= Date.now();
  }

  static async validateSession(user: IUser, outgoingIp?: string) {
    const adapter = new ZerodhaAdapter(outgoingIp || user.outgoing_ip);
    return adapter.refreshSession(user);
  }

  static async markDisconnected(userId: string, reason: string) {
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          zerodha_connected: false,
          zerodha_verified: false,
          broker_connected: false,
          broker_verified: false,
        },
      }
    );

    const user = await User.findById(userId).select("user_name email zerodha_user_id").lean();
    const label = user?.user_name || user?.email || userId;

    log.warn("[ZERODHA_SESSION] User marked disconnected", { userId, reason });
    await AlertService.trigger(
      "ZERODHA_SESSION_EXPIRED",
      `Zerodha session expired for user ${label} (${user?.zerodha_user_id || "unknown"}). Reason: ${reason}`,
      "HIGH"
    );
  }

  static async disconnect(user: IUser) {
    const adapter = new ZerodhaAdapter(user.outgoing_ip);
    if (user.zerodha_connected) {
      await adapter.logout(user);
    }

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          zerodha_connected: false,
          zerodha_verified: false,
          zerodha_access_token: null,
          zerodha_request_token: null,
          zerodha_refresh_token: null,
          zerodha_token_expiry: null,
          broker_connected: false,
          broker_verified: false,
        },
      }
    );
  }

  static getBrokerStatus(user: IUser) {
    const connected = Boolean(user.zerodha_connected);
    const verified = Boolean(user.zerodha_verified);
    const expired = connected && this.isSessionExpired(user);

    let status: "connected" | "disconnected" | "expired" = "disconnected";
    if (connected && expired) status = "expired";
    else if (connected && verified) status = "connected";

    return {
      broker: "Zerodha",
      status,
      connected,
      verified,
      expired,
      kiteUserId: user.zerodha_user_id || null,
      tokenExpiry: user.zerodha_token_expiry || null,
    };
  }
}
