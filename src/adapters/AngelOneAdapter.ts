// src/adapters/AngelOneAdapter.ts
import axios, { AxiosInstance } from "axios";
import https from "https";
import { config } from "../config";
import { log } from "../utils/logger";
import { decrypt } from "../utils/encryption";
import speakeasy from 'speakeasy';
import { ipv4Agent } from "../utils/httpAgent";

export type AngelSessionResp = {
  status?: boolean | string;
  message?: string;
  errorcode?: string;
  data?: any;
};

export class AngelOneAdapter {
  private apiKey: string;
  private client: AxiosInstance;
  private outgoingIp?: string;
  private loginPath: string = "/rest/auth/angelbroking/user/v1/loginByPassword";
  private tokenPath: string = "/rest/auth/angelbroking/jwt/v1/generateTokens";
  private refreshTokenPath: string = "/rest/auth/angelbroking/jwt/v1/refreshToken";

  constructor(apiKey?: string, outgoingIp?: string) {
    // [ISSUE 2 FIX] REMOVE global API key fallback completely
    this.apiKey = apiKey || "";
    this.outgoingIp = outgoingIp;

    if (!this.apiKey) {
      log.error("AngelOneAdapter: User API key missing. Connection rejected.");
      throw new Error("User API key missing. Please provide a valid API key in your profile.");
    }

    const agentOptions: any = {
      keepAlive: true,
      family: 4, // 🚀 FORCE IPv4
      timeout: 60000
    };

    if (this.outgoingIp) {
      agentOptions.localAddress = this.outgoingIp;
    }

    this.client = axios.create({
      baseURL: config.angelBaseUrl,
      timeout: 60000,
      httpsAgent: this.outgoingIp ? new https.Agent(agentOptions) : ipv4Agent
    });

    // Allow ENV override for token paths
    if (config.genPath) this.tokenPath = config.genPath;
    if (config.refreshPath) this.refreshTokenPath = config.refreshPath;
  }

  // common headers
  private baseHeaders(jwtToken?: string) {
    // [ISSUE 2 HARDENING] Strict validation layer
    const { validateApiKey, safeDecrypt, maskKey } = require("../utils/encryption");
    
    const rawKey = this.apiKey;
    const maskedRaw = rawKey.length > 10 ? rawKey.substring(0, 10) + "..." : "EMPTY";
    
    // 1. Validate Decrypted Key
    const decApiKey = safeDecrypt(rawKey, "angel_adapter_headers");
    
    if (!decApiKey || decApiKey.length < 10) {
        log.error(`[INVALID_API_KEY] Access blocked for Client: ${this.outgoingIp || 'Unknown'}. RawKey: ${maskedRaw} Decryption Failed.`);
        throw new Error("Invalid decrypted API key. Access Denied. Please reconnect broker.");
    }

    const maskedKeySnippet = decApiKey.substring(0, 4) + "****";
    const keySource = this.apiKey === config.angelApiKey ? "GLOBAL (UNAUTHORIZED)" : "USER";

    const headers: Record<string, string> = {
      "Content-type": "application/json",
      "Accept": "application/json",
      "X-ClientLocalIP": "127.0.0.1",
      "X-ClientPublicIP": this.outgoingIp || config.publicIp,
      "X-MACAddress": "fe:ed:fa:ce:12:34",
      "X-PrivateKey": decApiKey,
      "X-Api-Key": decApiKey,
      "X-UserType": "USER",
      "X-SourceID": "WEB"
    };

    log.debug(`[API_KEY_USED] Source: ${keySource} | Key: ${maskedKeySnippet}`);

    if (keySource === "GLOBAL (UNAUTHORIZED)") {
        log.warn("CRITICAL: System attempted to use Global API Key fallback. Access denied by enforcement.");
        throw new Error("Invalid API Key: Global fallback is no longer supported. Please update user profile API key.");
    }

    if (jwtToken) {
      const decJwt = decrypt(jwtToken, "jwt_token");
      if (!decJwt) {
          log.error("[INVALID_SESSION_TOKEN] Decryption failed for JWT");
          throw new Error("Invalid session token. Please re-login.");
      }
      headers["Authorization"] = `Bearer ${decJwt}`;
    }

    return headers;
  }

  // ------------ LOGIN (Trading APIs - Password Based) ------------


  async generateSession(params: {
    clientcode: string;
    password: string;
    totp?: string;
    totp_secret?: string; // [NEW] Added for automated generation
  }): Promise<AngelSessionResp> {
    let finalTotp = params.totp || "";

    // [NEW] Automated TOTP generation if secret is provided
    if (!finalTotp && params.totp_secret) {
      try {
        const cleanSecret = params.totp_secret.replace(/\s/g, '');
        finalTotp = speakeasy.totp({
          secret: cleanSecret,
          encoding: 'base32'
        });
        log.info(`Auto-generated TOTP for ${params.clientcode}`);
      } catch (e: any) {
        log.error(`TOTP Generation error for ${params.clientcode}: ${e.message}`);
      }
    }

    const body = {
      clientcode: params.clientcode,
      password: params.password,
      totp: finalTotp
    };

    log.info("[HTTP_AGENT] AngelOne API call (generateSession) forced to family: 4");
    try {
      const resp = await this.client.post(this.loginPath, body, {
        headers: this.baseHeaders(),
        httpsAgent: this.outgoingIp ? undefined : ipv4Agent // Explicit pass if not using local binding
      });

      log.debug("Angel loginByPassword response:", resp.data);

      return resp.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data || err.message;
      log.error("generateSession failed", status, data);
      throw new Error(`generateSession failed: ${JSON.stringify(data)}`);
    }
  }

  // ------------ OAUTH / PUBLISHER LOGIN FLOW ------------

  async generateSessionByAuthToken(authToken: string): Promise<AngelSessionResp> {
    const body = { refreshToken: authToken };
    log.info("[HTTP_AGENT] AngelOne API call (OAuth Token) forced to family: 4");
    try {
      const resp = await this.client.post(this.tokenPath, body, {
        headers: this.baseHeaders(),
        httpsAgent: this.outgoingIp ? undefined : ipv4Agent
      });
      log.debug("Angel generateTokens (OAuth) response:", resp.data);
      return resp.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data || err.message;
      log.error("generateTokensByAuthToken failed", status, data);
      throw new Error(`generateTokensByAuthToken failed: ${JSON.stringify(data)}`);
    }
  }

  // ------------ GENERIC AUTHP POST / GET ------------

  async authPost(jwtToken: string, path: string, body?: any) {
    log.info("[HTTP_AGENT] AngelOne API call (authPost) forced to family: 4");
    try {
      const resp = await this.client.post(path, body || {}, {
        headers: this.baseHeaders(jwtToken),
        httpsAgent: this.outgoingIp ? undefined : ipv4Agent
      });
      return resp.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data ?? err.message;

      if (status !== 431) {
        log.error("authPost error status:", status);
        log.error("authPost error body:", JSON.stringify(data, null, 2));
        log.error(`[DEBUG] Attempted with API Key (first 4): ${this.apiKey.substring(0, 4)} and ClientIP: ${config.publicIp}`);
      }

      throw new Error(
        `authPost error [${status}]: ${JSON.stringify(data)} (IP sent: ${config.publicIp})`
      );
    }
  }

  async authGet(jwtToken: string, path: string, params?: any) {
    log.info("[HTTP_AGENT] AngelOne API call (authGet) forced to family: 4");
    try {
      const resp = await this.client.get(path, {
        headers: this.baseHeaders(jwtToken),
        httpsAgent: this.outgoingIp ? undefined : ipv4Agent,
        params
      });
      return resp.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data ?? err.message;

      log.error("authGet error status:", status);
      log.error("authGet error body:", JSON.stringify(data, null, 2));
      log.error("authGet raw error:", err?.toString?.() || err);

      throw new Error(
        `authGet error [${status}]: ${JSON.stringify(data)}`
      );
    }
  }

  // ------------ PLACE ORDER (optional direct use) ------------

  async placeOrder(
    jwtToken: string,
    order: {
      exchange: string;
      tradingsymbol: string;
      transactiontype: "BUY" | "SELL";
      quantity: number;
      ordertype: "MARKET" | "LIMIT";
      price?: number;
      producttype?: string;
      duration?: string;
      symboltoken?: string;
      triggerPrice?: number;
    }
  ) {
    const path = "/rest/secure/angelbroking/order/v1/placeOrder";

    if (!order.symboltoken) {
      throw new Error(
        "symboltoken is required for placeOrder (AngelOne needs instrument token)."
      );
    }

    const payload: any = {
      variety: "NORMAL",
      tradingsymbol: order.tradingsymbol,
      symboltoken: order.symboltoken,
      transactiontype: order.transactiontype,
      exchange: order.exchange,
      ordertype: order.ordertype,
      producttype: order.producttype ?? "INTRADAY",
      duration: order.duration ?? "DAY",
      price: String(order.price ?? 0),
      quantity: String(order.quantity),
      squareoff: "0",
      stoploss: "0"
    };

    if (order.triggerPrice != null) {
      payload.triggerprice = String(order.triggerPrice);
    }

    return await this.authPost(jwtToken, path, payload);
  }

  // ------------ ORDER STATUS ------------

  async getOrderStatus(jwtToken: string, brokerOrderId: string) {
    const path = `/rest/secure/angelbroking/order/v1/getOrder?orderId=${encodeURIComponent(
      brokerOrderId
    )}`;
    return await this.authGet(jwtToken, path);
  }

  async getOrderBook(jwtToken: string) {
    const path = "/rest/secure/angelbroking/order/v1/getOrderBook";
    return await this.authGet(jwtToken, path);
  }

  // ------------ LTP / MARKET DATA ------------
  async getLtp(jwtToken: string, exchange: string, tradingsymbol: string, symboltoken: string) {
    const path = "/rest/secure/angelbroking/order/v1/getLtpData";
    const body = {
      exchange,
      tradingsymbol,
      symboltoken
    };
    return await this.authPost(jwtToken, path, body);
  }

  async getMarketData(jwtToken: string, mode: "LTP" | "QUOTE" | "FULL", exchangeTokens: Record<string, string[]>) {
    const path = "/rest/secure/angelbroking/market/v1/quote";
    const body = {
      mode,
      exchangeTokens
    };
    return await this.authPost(jwtToken, path, body);
  }

  // ------------ REFRESH TOKEN (OPTIONAL) ------------

  async generateTokensUsingRefresh(refreshToken: string) {
    const body = { refreshToken: decrypt(refreshToken) };
    log.info("[HTTP_AGENT] AngelOne API call (RefreshToken) forced to family: 4");
    try {
      const resp = await this.client.post(this.refreshTokenPath, body, {
        headers: this.baseHeaders(),
        httpsAgent: this.outgoingIp ? undefined : ipv4Agent
      });
      return resp.data;
    } catch (err: any) {
      const data = err?.response?.data || err.message;
      log.error("generateTokensUsingRefresh failed", data);
      throw new Error(
        `generateTokensUsingRefresh failed: ${JSON.stringify(data)}`
      );
    }
  }
  // ------------ USER PROFILE ------------
  async getProfile(jwtToken: string) {
    const path = "/rest/secure/angelbroking/user/v1/getProfile";
    log.info("[HTTP_AGENT] AngelOne API call (getProfile) forced to family: 4");
    try {
      const resp = await this.client.get(path, {
        headers: this.baseHeaders(jwtToken),
        httpsAgent: this.outgoingIp ? undefined : ipv4Agent
      });
      return resp.data;
    } catch (err: any) {
      // Return error structure rather than throwing for easier validation check
      const data = err?.response?.data ?? err.message;
      return { status: false, message: "Profile fetch failed", data };
    }
  }

  // ------------ RMS / FUNDS ------------
  async getRMS(jwtToken: string) {
    const path = "/rest/secure/angelbroking/user/v1/getRMS";
    try {
      const resp = await this.client.get(path, {
        headers: this.baseHeaders(jwtToken)
      });
      return resp.data;
    } catch (err: any) {
      const data = err?.response?.data ?? err.message;
      return { status: false, message: "RMS fetch failed", data };
    }
  }
}
