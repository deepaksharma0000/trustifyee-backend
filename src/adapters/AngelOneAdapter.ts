// src/adapters/AngelOneAdapter.ts
import axios, { AxiosInstance } from "axios";
import https from "https";
import { config } from "../config";
import { log } from "../utils/logger";
import { decrypt } from "../utils/encryption";
import speakeasy from 'speakeasy';

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
    this.apiKey = apiKey || config.angelApiKey;
    this.outgoingIp = outgoingIp;

    const agentOptions: any = {
      keepAlive: true,
      timeout: 60000
    };

    if (this.outgoingIp) {
      agentOptions.localAddress = this.outgoingIp;
    }

    this.client = axios.create({
      baseURL: config.angelBaseUrl,
      timeout: 60000,
      httpsAgent: new https.Agent(agentOptions)
    });

    // Allow ENV override for token paths
    if (config.genPath) this.tokenPath = config.genPath;
    if (config.refreshPath) this.refreshTokenPath = config.refreshPath;
  }

  // common headers
  private baseHeaders(jwtToken?: string) {
    const headers: Record<string, string> = {
      "Content-type": "application/json",
      "Accept": "application/json",
      "X-ClientLocalIP": "127.0.0.1",
      "X-ClientPublicIP": this.outgoingIp || config.publicIp, // [FIX] Use assigned IPv6 if present
      "X-MACAddress": "fe:ed:fa:ce:12:34",
      "X-PrivateKey": this.apiKey,
      "X-Api-Key": this.apiKey, // [FIX] Added standard API Key header
      "X-UserType": "USER",
      "X-SourceID": "WEB"
    };

    log.debug(`[AngelAPI] Sending request with PrivateKey (first 4): ${this.apiKey.substring(0, 4)}...`);

    if (jwtToken) {
      headers["Authorization"] = `Bearer ${decrypt(jwtToken)}`;
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

    try {
      const resp = await this.client.post(this.loginPath, body, {
        headers: this.baseHeaders()
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
    try {
      const resp = await this.client.post(this.tokenPath, body, {
        headers: this.baseHeaders()
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
    try {
      const resp = await this.client.post(path, body || {}, {
        headers: this.baseHeaders(jwtToken)
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
    try {
      const resp = await this.client.get(path, {
        headers: this.baseHeaders(jwtToken),
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
    try {
      const resp = await this.client.post(this.refreshTokenPath, body, {
        headers: this.baseHeaders()
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
    try {
      const resp = await this.client.get(path, {
        headers: this.baseHeaders(jwtToken)
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
