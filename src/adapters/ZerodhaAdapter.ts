import axios, { AxiosInstance } from "axios";
import crypto from "crypto";
import { config } from "../config";
import log from "../utils/logger";
import { decrypt, encrypt } from "../utils/encryption";
import { IBrokerAdapter } from "./IBrokerAdapter";
import { IUser } from "../models/User";

export class ZerodhaAdapter implements IBrokerAdapter {
  private client: AxiosInstance;
  private outgoingIp?: string;

  constructor(outgoingIp?: string) {
    this.outgoingIp = outgoingIp;

    const { ipv4Agent } = require("../utils/httpAgent");
    const https = require("https");

    const agentOptions: any = {
      keepAlive: true,
      family: 4,
      timeout: 15000
    };

    if (this.outgoingIp) {
      agentOptions.localAddress = this.outgoingIp;
    }

    const baseUrl = config.zerodhaBaseUrl || "https://api.kite.trade";

    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 15000,
      httpsAgent: this.outgoingIp ? new https.Agent(agentOptions) : ipv4Agent
    });

    log.debug("ZerodhaAdapter initialized:", {
      baseUrl,
      outgoingIp: this.outgoingIp || 'DEFAULT'
    });
  }

  private getAuthHeaders(apiKey: string, accessToken: string) {
    return {
      "X-Kite-Version": "3",
      "Authorization": `token ${apiKey}:${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    };
  }

  /**
   * Helper to decrypt Zerodha fields from IUser
   */
  private getDecryptedCredentials(user: IUser) {
    const decryptSafe = (val?: string) => {
      if (!val) return "";
      try {
        return decrypt(val);
      } catch {
        return val;
      }
    };

    return {
      userId: user.zerodha_user_id || "",
      apiKey: decryptSafe(user.zerodha_api_key),
      apiSecret: decryptSafe(user.zerodha_api_secret),
      accessToken: decryptSafe(user.zerodha_access_token)
    };
  }

  /**
   * Generates authorization URL for Zerodha login redirect
   */
  getAuthUrl(apiKey: string): string {
    return `https://kite.zerodha.com/connect/login?api_key=${apiKey}&v=3`;
  }

  /**
   * Exchange request token for access token
   */
  async exchangeToken(apiKey: string, apiSecret: string, requestToken: string): Promise<any> {
    const checksumInput = apiKey + requestToken + apiSecret;
    const checksum = crypto.createHash("sha256").update(checksumInput).digest("hex");

    const body = new URLSearchParams({
      api_key: apiKey,
      request_token: requestToken,
      checksum: checksum
    });

    try {
      const response = await this.client.post("/session/token", body.toString(), {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json"
        }
      });
      return response.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      log.error("Zerodha token exchange failed:", {
        status,
        error: data,
        message: err.message
      });
      throw new Error(`Zerodha login failed: ${data?.message || err.message}`);
    }
  }

  async connect(user: IUser, authCodeOrCredentials: any): Promise<any> {
    const apiKey = authCodeOrCredentials.apiKey || decrypt(user.zerodha_api_key || "");
    const apiSecret = authCodeOrCredentials.apiSecret || decrypt(user.zerodha_api_secret || "");
    const requestToken = authCodeOrCredentials.requestToken || authCodeOrCredentials.code;

    if (!apiKey || !apiSecret || !requestToken) {
      throw new Error("Missing api_key, api_secret, or request_token for Zerodha connection.");
    }

    const tokenResp = await this.exchangeToken(apiKey, apiSecret, requestToken);
    const expiresAt = new Date(Date.now() + (24 * 60 * 60 * 1000)); // ~24h

    const User = require("../models/User").default;
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          zerodha_user_id: tokenResp.data.user_id,
          zerodha_api_key: encrypt(apiKey),
          zerodha_api_secret: encrypt(apiSecret),
          zerodha_request_token: encrypt(requestToken),
          zerodha_access_token: encrypt(tokenResp.data.access_token),
          zerodha_refresh_token: tokenResp.data.refresh_token ? encrypt(tokenResp.data.refresh_token) : undefined,
          zerodha_token_expiry: expiresAt,
          zerodha_connected: true,
          zerodha_verified: true,
          broker_connected: true,
          broker_verified: true,
          broker: "Zerodha"
        }
      }
    );

    return tokenResp;
  }

  async refreshSession(user: IUser): Promise<any> {
    const credentials = this.getDecryptedCredentials(user);
    if (!credentials.apiKey || !credentials.accessToken) {
      throw new Error("Missing credentials for Zerodha session check");
    }

    try {
      const response = await this.client.get("/user/profile", {
        headers: this.getAuthHeaders(credentials.apiKey, credentials.accessToken)
      });
      return { status: true, message: "Session is valid", profile: response.data };
    } catch (err: any) {
      log.warn("Zerodha session validation failed, marking user disconnected", {
        userId: user._id,
        message: err.message
      });
      const User = require("../models/User").default;
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            zerodha_connected: false,
            zerodha_verified: false,
            broker_connected: false,
            broker_verified: false
          }
        }
      );
      throw new Error("Zerodha session expired or invalid. Please connect again.");
    }
  }

  async placeOrder(user: IUser, payload: any): Promise<any> {
    const credentials = this.getDecryptedCredentials(user);
    if (!credentials.apiKey || !credentials.accessToken) {
      throw new Error("Missing Zerodha session credentials");
    }

    const variety = payload.variety || "regular";
    const body = new URLSearchParams();
    for (const key of Object.keys(payload)) {
      if (key !== "variety") {
        body.append(key, String(payload[key]));
      }
    }

    try {
      const response = await this.client.post(`/orders/${variety}`, body.toString(), {
        headers: this.getAuthHeaders(credentials.apiKey, credentials.accessToken)
      });
      log.info("Zerodha order placed successfully", {
        userId: user._id,
        response: response.data
      });
      return response.data;
    } catch (err: any) {
      const data = err?.response?.data;
      log.error("Zerodha order placement failed:", {
        userId: user._id,
        error: data,
        message: err.message
      });
      throw new Error(data?.message || err.message);
    }
  }

  async modifyOrder(user: IUser, orderId: string, payload: any): Promise<any> {
    const credentials = this.getDecryptedCredentials(user);
    if (!credentials.apiKey || !credentials.accessToken) {
      throw new Error("Missing Zerodha session credentials");
    }

    const variety = payload.variety || "regular";
    const body = new URLSearchParams();
    for (const key of Object.keys(payload)) {
      if (key !== "variety") {
        body.append(key, String(payload[key]));
      }
    }

    try {
      const response = await this.client.put(`/orders/${variety}/${orderId}`, body.toString(), {
        headers: this.getAuthHeaders(credentials.apiKey, credentials.accessToken)
      });
      return response.data;
    } catch (err: any) {
      const data = err?.response?.data;
      throw new Error(data?.message || err.message);
    }
  }

  async cancelOrder(user: IUser, orderId: string, payload?: any): Promise<any> {
    const credentials = this.getDecryptedCredentials(user);
    if (!credentials.apiKey || !credentials.accessToken) {
      throw new Error("Missing Zerodha session credentials");
    }

    const variety = (payload && payload.variety) || "regular";
    const params = new URLSearchParams();
    if (payload?.parent_order_id) {
      params.append("parent_order_id", payload.parent_order_id);
    }

    try {
      const response = await this.client.delete(`/orders/${variety}/${orderId}`, {
        headers: this.getAuthHeaders(credentials.apiKey, credentials.accessToken),
        params
      });
      return response.data;
    } catch (err: any) {
      const data = err?.response?.data;
      throw new Error(data?.message || err.message);
    }
  }

  async getPositions(user: IUser): Promise<any> {
    const credentials = this.getDecryptedCredentials(user);
    if (!credentials.apiKey || !credentials.accessToken) {
      throw new Error("Missing Zerodha session credentials");
    }

    try {
      const response = await this.client.get("/portfolio/positions", {
        headers: this.getAuthHeaders(credentials.apiKey, credentials.accessToken)
      });
      return response.data;
    } catch (err: any) {
      const data = err?.response?.data;
      throw new Error(data?.message || err.message);
    }
  }

  async getHoldings(user: IUser): Promise<any> {
    const credentials = this.getDecryptedCredentials(user);
    if (!credentials.apiKey || !credentials.accessToken) {
      throw new Error("Missing Zerodha session credentials");
    }

    try {
      const response = await this.client.get("/portfolio/holdings", {
        headers: this.getAuthHeaders(credentials.apiKey, credentials.accessToken)
      });
      return response.data;
    } catch (err: any) {
      const data = err?.response?.data;
      throw new Error(data?.message || err.message);
    }
  }

  async getFunds(user: IUser): Promise<any> {
    const credentials = this.getDecryptedCredentials(user);
    if (!credentials.apiKey || !credentials.accessToken) {
      throw new Error("Missing Zerodha session credentials");
    }

    try {
      const response = await this.client.get("/user/margins", {
        headers: this.getAuthHeaders(credentials.apiKey, credentials.accessToken)
      });
      return response.data;
    } catch (err: any) {
      const data = err?.response?.data;
      throw new Error(data?.message || err.message);
    }
  }

  async getOrders(user: IUser): Promise<any> {
    const credentials = this.getDecryptedCredentials(user);
    if (!credentials.apiKey || !credentials.accessToken) {
      throw new Error("Missing Zerodha session credentials");
    }

    try {
      const response = await this.client.get("/orders", {
        headers: this.getAuthHeaders(credentials.apiKey, credentials.accessToken)
      });
      return response.data;
    } catch (err: any) {
      const data = err?.response?.data;
      throw new Error(data?.message || err.message);
    }
  }

  async logout(user: IUser): Promise<any> {
    const credentials = this.getDecryptedCredentials(user);
    if (credentials.apiKey && credentials.accessToken) {
      try {
        const body = new URLSearchParams({
          api_key: credentials.apiKey,
          access_token: credentials.accessToken
        });
        await this.client.delete("/session/token", {
          headers: this.getAuthHeaders(credentials.apiKey, credentials.accessToken),
          data: body.toString()
        });
      } catch (err) {
        log.warn("Zerodha session invalidation on logout failed", err);
      }
    }

    const User = require("../models/User").default;
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          zerodha_connected: false,
          zerodha_verified: false,
          zerodha_access_token: null,
          zerodha_request_token: null,
          broker_connected: false,
          broker_verified: false
        }
      }
    );
    return { status: true, message: "Logged out successfully" };
  }
}
