import axios, { AxiosInstance } from "axios";
import https from "https";
import speakeasy from "speakeasy";
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
  private static shouldLogInit = process.env.LOG_ADAPTER_INIT === "true";
  private apiKey: string;
  private client: AxiosInstance;
  private outgoingIp?: string;
  private agentUrl?: string;
  private tokenPath = "/rest/auth/angelbroking/jwt/v1/generateTokens";
  private refreshTokenPath = "/rest/auth/angelbroking/jwt/v1/refreshToken";
  private isDataAccount: boolean;

  private forcedBaseUrl = "https://apiconnect.angelone.in";

  constructor(apiKey?: string, outgoingIp?: string, isDataAccount: boolean = false, agentUrl?: string) {
    this.apiKey = apiKey || "";
    this.outgoingIp = outgoingIp;
    this.agentUrl = agentUrl;
    this.isDataAccount = isDataAccount;

    if (!this.apiKey) {
      log.error("AngelOneAdapter: API key missing.");
      throw new Error("API key missing. Access Denied.");
    }

    this.client = axios.create({
      baseURL: this.forcedBaseUrl,
      timeout: 60000,
      httpsAgent: ipv4Agent,
    });

    if (AngelOneAdapter.shouldLogInit) {
      log.debug("[ADAPTER_INIT] AngelOne adapter initialized", {
        mode: isDataAccount ? "DEDICATED_DATA" : "USER_SESSION",
        outgoingIp: this.outgoingIp || "",
        hasAgent: Boolean(this.agentUrl),
      });
    }

    if (config.genPath) this.tokenPath = config.genPath;
    if (config.refreshPath) this.refreshTokenPath = config.refreshPath;
  }

  private baseHeaders(jwtToken?: string) {
    const { safeDecrypt } = require("../utils/encryption");

    const decApiKey = safeDecrypt(this.apiKey, "angel_adapter_headers");
    if (!decApiKey) throw new Error("Invalid decryption key. Access Denied.");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-UserType": "USER",
      "X-SourceID": "WEB",
      "X-ClientLocalIP": "127.0.0.1",
      "X-ClientPublicIP": config.publicIp || "127.0.0.1",
      "X-MACAddress": "00:00:00:00:00:00",
      "X-PrivateKey": decApiKey,
      "X-Api-Key": decApiKey,
    };

    if (jwtToken) {
      const decJwt = decrypt(jwtToken, "jwt_token");
      if (decJwt) headers.Authorization = `Bearer ${decJwt}`;
    }

    return headers;
  }

  async generateSession(credentials: {
    clientcode: string;
    password: string;
    totp: string;
    totp_secret?: string;
  }) {
    const path = "/rest/auth/angelbroking/user/v1/loginByPassword";

    let finalTotp = credentials.totp;
    if (!finalTotp && credentials.totp_secret) {
      try {
        finalTotp = speakeasy.totp({
          secret: credentials.totp_secret,
          encoding: "base32",
        });
      } catch (err: any) {
        log.error("[TOTP_ERROR] Could not generate TOTP", {
          clientcode: credentials.clientcode,
          message: err?.message,
        });
      }
    }

    const payload = {
      clientcode: credentials.clientcode,
      password: credentials.password,
      totp: finalTotp,
    };

    log.info("[LOGIN_ATTEMPT] AngelOne login request", {
      clientcode: credentials.clientcode,
      hasTotp: Boolean(finalTotp),
      hasTotpSecret: Boolean(credentials.totp_secret),
    });

    try {
      return await this.client.post(path, payload, {
        headers: this.baseHeaders(),
      });
    } catch (err: any) {
      const errorData = err?.response?.data || {};
      const errorMessage = String(errorData.message || errorData.emsg || err.message || "").toUpperCase();

      const isInvalidMPIN =
        errorMessage.includes("INVALID MPIN") ||
        errorMessage.includes("INVALID PASSWORD") ||
        errorData.errorcode === "AB1008" ||
        errorMessage.includes("MAXIMUM ATTEMPTS");

      log.error("[LOGIN_FAILED] AngelOne login failed", {
        clientcode: credentials.clientcode,
        errorCode: errorData.errorcode,
        errorMessage: errorData.message || err.message,
      });

      if (isInvalidMPIN) {
        const fatalError = new Error("INVALID_MPIN_FATAL");
        (fatalError as any).isFatal = true;
        (fatalError as any).brokerCode = errorData.errorcode;
        throw fatalError;
      }

      throw err;
    }
  }

  async generateSessionByAuthToken(authToken: string): Promise<any> {
    const body = { refreshToken: authToken };
    return this.client.post(this.tokenPath, body, {
      headers: this.baseHeaders(),
    });
  }

  async authPost(jwtToken: string, path: string, body?: any) {
    if (this.apiKey === config.dataApiKey && path.includes("/order")) {
      throw new Error("DATA_ACCOUNT_CANNOT_TRADE");
    }

    return this.client.post(path, body || {}, {
      headers: this.baseHeaders(jwtToken),
    });
  }

  async authGet(jwtToken: string, path: string, params?: any) {
    return this.client.get(path, {
      headers: this.baseHeaders(jwtToken),
      params,
    });
  }

  async getMarketData(
    jwtToken: string,
    mode: "LTP" | "QUOTE" | "FULL",
    exchangeTokens: Record<string, string[]>
  ) {
    return this.authPost(jwtToken, "/rest/secure/angelbroking/market/v1/quote", {
      mode,
      exchangeTokens,
    });
  }

  async getLtp(jwtToken: string, exchange: string, tradingsymbol: string, symboltoken: string) {
    return this.authPost(jwtToken, "/rest/secure/angelbroking/order/v1/getLtpData", {
      exchange,
      tradingsymbol,
      symboltoken,
    });
  }

  async generateTokensUsingRefresh(refreshToken: string) {
    const body = { refreshToken: decrypt(refreshToken) };
    return this.client.post(this.refreshTokenPath, body, {
      headers: this.baseHeaders(),
    });
  }

  async getProfile(jwtToken: string) {
    return this.authGet(jwtToken, "/rest/secure/angelbroking/user/v1/getProfile");
  }

  async getRMS(jwtToken: string) {
    return this.authGet(jwtToken, "/rest/secure/angelbroking/user/v1/getRMS");
  }

  async getOrderBook(token: string) {
    return this.authPost(token, "/rest/secure/angelbroking/order/v1/getOrderBook");
  }

  async getOrderStatus(token: string, orderId: string) {
    return this.authGet(token, `/rest/secure/angelbroking/order/v1/getOrderStatus/${orderId}`);
  }

  async searchScrip(token: string, exchange: string, searchtext: string) {
    return this.authPost(token, "/rest/secure/angelbroking/order/v1/searchScrip", {
      exchange,
      searchtext,
    });
  }

  async placeOrder(jwtToken: string, payload: any) {
    const isIpValid = Boolean(this.outgoingIp && String(this.outgoingIp).trim() !== "");
    const hasAgent = Boolean(this.agentUrl && String(this.agentUrl).trim() !== "");

    if (hasAgent && this.agentUrl) {
      const { safeDecrypt } = require("../utils/encryption");
      const decApiKey = safeDecrypt(this.apiKey, "agent_routing");

      const agentPayload = {
        secret: config.agentSecret,
        jwtToken: decrypt(jwtToken, "agent_routing_jwt"),
        apiKey: decApiKey,
        orderPayload: payload,
      };

      try {
        return await axios.post(`${this.agentUrl}/place-order`, agentPayload, { timeout: 15000 });
      } catch (err: any) {
        log.error("[AGENT_ERROR] Failed order routing to agent", {
          agentUrl: this.agentUrl,
          message: err?.message,
        });
        throw err;
      }
    }

    if (isIpValid && this.outgoingIp) {
      const bindingAgent = new https.Agent({
        family: 4,
        localAddress: this.outgoingIp,
        keepAlive: true,
        timeout: 60000,
      });

      try {
        return await axios.post(
          `${this.forcedBaseUrl}/rest/secure/angelbroking/order/v1/placeOrder`,
          payload,
          {
            headers: this.baseHeaders(jwtToken),
            httpsAgent: bindingAgent,
            timeout: 60000,
          }
        );
      } catch (err: any) {
        const code = String(err?.code || "");
        if (code !== "EADDRNOTAVAIL" && code !== "EINVAL") {
          throw err;
        }

        log.warn("[DIRECT_BINDING_FALLBACK] Local IP bind failed. Retrying via default route.", {
          outgoingIp: this.outgoingIp,
          code,
        });
      }
    }

    if (!isIpValid && !hasAgent && !this.isDataAccount) {
      log.warn("[ORDER_NETWORK_FALLBACK] No dedicated IP/agent provided. Using server network route.");
    }

    return this.authPost(jwtToken, "/rest/secure/angelbroking/order/v1/placeOrder", payload);
  }
}
