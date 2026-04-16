// src/adapters/AngelOneAdapter.ts
import axios, { AxiosInstance } from "axios";
import https from "https";
import { config } from "../config";
import log from "../utils/logger";
import { decrypt } from "../utils/encryption";
import { ipv4Agent } from "../utils/httpAgent";

export type AngelSessionResp = {
  status?: boolean | string | number;
  message?: string;
  errorcode?: string;
  data?: any;
};

export class AngelOneAdapter {
  private apiKey: string;
  private client: AxiosInstance;
  private outgoingIp?: string;
  private tokenPath: string = "/rest/auth/angelbroking/jwt/v1/generateTokens";
  private refreshTokenPath: string = "/rest/auth/angelbroking/jwt/v1/refreshToken";

  // Force official production URL to avoid 405/proxy issues
  private forcedBaseUrl: string = "https://apiconnect.angelone.in";

  constructor(apiKey?: string, outgoingIp?: string, isDataAccount: boolean = false) {
    this.apiKey = apiKey || "";
    this.outgoingIp = outgoingIp;

    if (!this.apiKey) {
      log.error("AngelOneAdapter: API key missing.");
      throw new Error("API key missing. Access Denied.");
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
      baseURL: this.forcedBaseUrl,
      timeout: 60000,
      httpsAgent: this.outgoingIp ? new https.Agent(agentOptions) : ipv4Agent
    });

    log.info(`[DATA_ACCOUNT_USED] Adapter initialized | Mode: ${isDataAccount ? 'DEDICATED_DATA' : 'USER_SESSION'} | URL: ${this.forcedBaseUrl}`);

    // Allow ENV override for token paths
    if (config.genPath) this.tokenPath = config.genPath;
    if (config.refreshPath) this.refreshTokenPath = config.refreshPath;
  }

  // common headers
  private baseHeaders(jwtToken?: string) {
    const { safeDecrypt } = require("../utils/encryption");
    
    // 1. Validate Decrypted Key
    const decApiKey = safeDecrypt(this.apiKey, "angel_adapter_headers");
    if (!decApiKey) throw new Error("Invalid decryption key. Access Denied.");

    const headers: Record<string, string> = {
        'Accept': 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': config.publicIp || '127.0.0.1',
        'X-MACAddress': '00:00:00:00:00:00',
        'X-PrivateKey': decApiKey,
        'X-Api-Key': decApiKey
      };

      if (jwtToken) {
        const decJwt = decrypt(jwtToken, "jwt_token");
        if (decJwt) headers['Authorization'] = `Bearer ${decJwt}`;
      }

    return headers;
  }

  // ------------ LOGIN (Trading APIs - Password Based) ------------
  async generateSession(credentials: { clientcode: string; password: string; totp: string; totp_secret?: string }) {
    const path = "/rest/auth/angelbroking/user/v1/loginByPassword";
    const fullUrl = `${this.forcedBaseUrl}${path}`;
    
    log.info(`[LOGIN_REQUEST] LOGIN_URL: ${fullUrl} | Account: ${credentials.clientcode}`);
    
    try {
      const resp = await this.client.post(path, credentials, {
        headers: this.baseHeaders(),
      });
      return resp;
    } catch (err: any) {
      log.error("Login session failed", err?.response?.data || err.message);
      throw err;
    }
  }

  // ------------ OAUTH / PUBLISHER LOGIN FLOW ------------
  async generateSessionByAuthToken(authToken: string): Promise<any> {
    const body = { refreshToken: authToken };
    try {
      const resp = await this.client.post(this.tokenPath, body, {
        headers: this.baseHeaders(),
      });
      return resp;
    } catch (err: any) {
      throw err;
    }
  }

  // ------------ GENERIC AUTHP POST / GET ------------
  async authPost(jwtToken: string, path: string, body?: any) {
    if (path.includes('/order/v1/placeOrder')) {
        throw new Error("SERVER_SIDE_EXECUTION_DISABLED");
    }
    // [DATA_FEED GUARD]
    if (this.apiKey === config.dataApiKey && path.includes('/order')) {
        throw new Error("DATA_ACCOUNT_CANNOT_TRADE");
    }

    try {
      const resp = await this.client.post(path, body || {}, {
        headers: this.baseHeaders(jwtToken),
      });
      return resp;
    } catch (err: any) {
      throw err;
    }
  }

  async authGet(jwtToken: string, path: string, params?: any) {
    try {
      const resp = await this.client.get(path, {
        headers: this.baseHeaders(jwtToken),
        params
      });
      return resp;
    } catch (err: any) {
      throw err;
    }
  }

  // ------------ MARKET DATA ------------
  async getMarketData(jwtToken: string, mode: "LTP" | "QUOTE" | "FULL", exchangeTokens: Record<string, string[]>) {
    const path = "/rest/secure/angelbroking/market/v1/quote";
    const body = { mode, exchangeTokens };
    return await this.authPost(jwtToken, path, body);
  }

  async getLtp(jwtToken: string, exchange: string, tradingsymbol: string, symboltoken: string) {
    const path = "/rest/secure/angelbroking/order/v1/getLtpData";
    const body = { exchange, tradingsymbol, symboltoken };
    return await this.authPost(jwtToken, path, body);
  }

  async generateTokensUsingRefresh(refreshToken: string) {
    const body = { refreshToken: decrypt(refreshToken) };
    return await this.client.post(this.refreshTokenPath, body, {
        headers: this.baseHeaders(),
      });
  }

  async getProfile(jwtToken: string) {
    const path = "/rest/secure/angelbroking/user/v1/getProfile";
    return await this.authGet(jwtToken, path);
  }

  async getRMS(jwtToken: string) {
    const path = "/rest/secure/angelbroking/user/v1/getRMS";
    return await this.authGet(jwtToken, path);
  }

  async getOrderBook(token: string) {
    return this.authPost(token, "/rest/secure/angelbroking/order/v1/getOrderBook");
  }

  async getOrderStatus(token: string, orderId: string) {
    const path = "/rest/secure/angelbroking/order/v1/getOrderStatus/" + orderId;
    return this.authGet(token, path);
  }

  async searchScrip(token: string, exchange: string, searchtext: string) {
    const path = "/rest/secure/angelbroking/order/v1/searchScrip";
    const body = { exchange, searchtext };
    return await this.authPost(token, path, body);
  }
}
