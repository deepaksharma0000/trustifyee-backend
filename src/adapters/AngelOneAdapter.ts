// src/adapters/AngelOneAdapter.ts
import axios, { AxiosInstance } from "axios";
import { config } from "../config";
import { log } from "../utils/logger";

export type AngelSessionResp = {
  status?: boolean | string;
  message?: string;
  errorcode?: string;
  data?: any;
};

export class AngelOneAdapter {
  private apiKey: string;
  private client: AxiosInstance;

  // official SmartAPI paths
  private loginPath = "/rest/auth/angelbroking/user/v1/loginByPassword";
  private tokenPath = "/rest/auth/angelbroking/jwt/v1/generateTokens";
  private refreshTokenPath = "/rest/auth/angelbroking/jwt/v1/refreshToken";

  constructor() {
    this.apiKey = config.angelApiKey;
    this.client = axios.create({
      baseURL: config.angelBaseUrl,
      timeout: 15000
    });
    this.tokenPath = config.genPath || this.tokenPath;
    this.refreshTokenPath = config.refreshPath || this.refreshTokenPath;
  }

  // common headers
  private baseHeaders(jwtToken?: string) {
    const headers: Record<string, string> = {
      "Content-type": "application/json",
      Accept: "application/json",
      "X-ClientLocalIP": "127.0.0.1",
      "X-ClientPublicIP": "106.193.147.98",
      "X-MACAddress": "fe:ed:fa:ce:12:34",
      "X-PrivateKey": this.apiKey,
      "X-UserType": "USER",
      "X-SourceID": "WEB"
    };

    if (jwtToken) {
      headers["Authorization"] = `Bearer ${jwtToken}`;
    }

    return headers;
  }

  // ------------ LOGIN ------------

  async generateSession(params: {
    clientcode: string;
    password: string;
    totp?: string;
  }): Promise<AngelSessionResp> {
    const body = {
      clientcode: params.clientcode,
      password: params.password,
      totp: params.totp || ""
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

      if (status !== 403 && status !== 429) {
        log.error("authPost error status:", status);
        log.error("authPost error body:", JSON.stringify(data, null, 2));
        log.error("authPost raw error:", err?.toString?.() || err);
      }

      throw new Error(
        `authPost error [${status}]: ${JSON.stringify(data)}`
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

  // ------------ REFRESH TOKEN (OPTIONAL) ------------

  async generateTokensUsingRefresh(refreshToken: string) {
    const body = { refreshToken };
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
}
