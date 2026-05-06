// src/adapters/AngelOneAdapter.ts
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
  private apiKey: string;
  private client: AxiosInstance;
  private outgoingIp?: string;
  private agentUrl?: string;
  private tokenPath: string = "/rest/auth/angelbroking/jwt/v1/generateTokens";
  private refreshTokenPath: string = "/rest/auth/angelbroking/jwt/v1/refreshToken";
  private isDataAccount: boolean;

  // Force official production URL to avoid 405/proxy issues
  private forcedBaseUrl: string = "https://apiconnect.angelone.in";

  constructor(apiKey?: string, outgoingIp?: string, isDataAccount: boolean = false, agentUrl?: string) {
    this.apiKey = apiKey || "";
    this.outgoingIp = outgoingIp;
    this.agentUrl = agentUrl;
    this.isDataAccount = isDataAccount;

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
      log.info(`[ADAPTER_BIND] Using manual outgoing IP: ${this.outgoingIp}`);
    }

    const isIPv4 = (ip: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);

    if (this.outgoingIp && !isIPv4(this.outgoingIp)) {
        log.error(`[ADAPTER_BIND_ERROR] Invalid IPv4 format: ${this.outgoingIp}. Blocking trade.`);
        this.outgoingIp = undefined; // Force invalidation
    }

    // 🛡️ [REMOVED FROM CONSTRUCTOR] Strict IP validation now happens in placeOrder
    const isIpValid = this.outgoingIp && String(this.outgoingIp).trim() !== "";
    const hasAgent = this.agentUrl && String(this.agentUrl).trim() !== "";

    this.client = axios.create({
      baseURL: this.forcedBaseUrl,
      timeout: 60000,
      httpsAgent: (isIpValid && !hasAgent) ? new https.Agent(agentOptions) : ipv4Agent
    });

    log.info(`[ADAPTER_INIT] Mode: ${isDataAccount ? 'DEDICATED_DATA' : 'USER_SESSION'} | IP: ${this.outgoingIp || 'DEFAULT'} | Agent: ${this.agentUrl || 'NONE'}`);

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
        'Content-Type': 'application/json',
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
    const { clientcode, password, totp, totp_secret } = credentials;
    
    // 🛡️ SEBI COMPLIANCE: Only enforce for non-data accounts
    const isIpValid = this.outgoingIp && String(this.outgoingIp).trim() !== "";
    const hasAgent = this.agentUrl && String(this.agentUrl).trim() !== "";

    if (!isIpValid && !hasAgent && !this.isDataAccount) {
        log.error(`[LOGIN_ERROR] Login for ${clientcode} requires a valid static IP or VPS Agent. Blocking.`);
        throw new Error("User static IP not registered. Please contact admin.");
    }

    // 🛡️ [DIAGNOSTIC LOG] - Show what's being sent (masked)
    const maskedPsw = password ? (password.substring(0, 2) + "****") : "MISSING";
    log.info(`[LOGIN_ATTEMPT] Client: ${clientcode}, MPIN: ${maskedPsw}, TOTP_PROVIDED: ${!!totp || !!totp_secret}`);

    // 🚀 RESTORED TO v1 ENDPOINT (v2 is being blocked by WAF/Firewall)
    const path = "/rest/auth/angelbroking/user/v1/loginByPassword";
    const fullUrl = `${this.forcedBaseUrl}${path}`;
    
    // 🛡️ Automated TOTP Generation
    let finalTotp = credentials.totp;
    if (!finalTotp && credentials.totp_secret) {
        try {
            finalTotp = speakeasy.totp({
                secret: credentials.totp_secret,
                encoding: 'base32'
            });
            log.info(`[TOTP] Generated auto-TOTP for ${credentials.clientcode}`);
        } catch (err: any) {
            log.error(`[TOTP_ERROR] Failed to generate TOTP from secret for ${credentials.clientcode}:`, err.message);
        }
    }

    const payload = {
        clientcode: credentials.clientcode,
        password: credentials.password,
        totp: finalTotp
    };

    log.info(`[LOGIN_REQUEST] LOGIN_URL: ${fullUrl} | Account: ${credentials.clientcode}`);
    log.info(`[LOGIN_DEBUG] Payload being sent: clientcode=${credentials.clientcode}, apikey=${this.apiKey?.slice(0,4)}****, totp=${finalTotp}`);
    
    try {
      const resp = await this.client.post(path, payload, {
        headers: this.baseHeaders(),
      });
      return resp;
    } catch (err: any) {
      const errorData = err?.response?.data || {};
      const errorMessage = String(errorData.message || errorData.emsg || err.message || "").toUpperCase();
      
      log.error(`[LOGIN_RAW_ERROR] Full Response: ${JSON.stringify(errorData)}`);

      // 🛡️ [MPIN GUARD] - If MPIN is invalid, do NOT retry. Throw fatal error to stop loop.
      // Error code AB1008 and message "INVALID MPIN" are critical triggers.
      const isInvalidMPIN = errorMessage.includes("INVALID MPIN") || 
                            errorMessage.includes("INVALID PASSWORD") || 
                            errorData.errorcode === "AB1008" ||
                            errorMessage.includes("MAXIMUM ATTEMPTS");

      if (isInvalidMPIN) {
          log.error(`[FATAL_LOGIN_ERROR] ${errorMessage} for ${credentials.clientcode}. Stopping all auto-login attempts to prevent account lock.`);
          const fatalError = new Error("INVALID_MPIN_FATAL");
          (fatalError as any).isFatal = true;
          (fatalError as any).brokerCode = errorData.errorcode;
          throw fatalError;
      }

      log.error(`[LOGIN_FAILED] Attempt failed for ${credentials.clientcode}: ${errorMessage}`);
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
    // Server-side execution enabled via backend worker

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

  // ------------ VPS AGENT ROUTING ------------
  async placeOrder(jwtToken: string, payload: any) {
    const isIpValid = this.outgoingIp && String(this.outgoingIp).trim() !== "";
    const hasAgent = this.agentUrl && String(this.agentUrl).trim() !== "";

    // 🛡️ SEBI COMPLIANCE: Only enforce for non-data accounts
    if (!isIpValid && !hasAgent && !this.isDataAccount) {
        log.error(`[PLACE_ORDER_ERROR] Order placement requires a valid static IP or VPS Agent. Blocking.`);
        throw new Error("User static IP not registered. Please contact admin.");
    }

    if (this.agentUrl) {
        const { safeDecrypt } = require("../utils/encryption");
        const decApiKey = safeDecrypt(this.apiKey, "agent_routing");
        
        const agentPayload = {
            secret: config.agentSecret,
            jwtToken: decrypt(jwtToken, "agent_routing_jwt"),
            apiKey: decApiKey,
            orderPayload: payload
        };

        log.info(`[AGENT_ROUTING] Routing order for ${payload.tradingsymbol} to ${this.agentUrl}`);
        try {
            const resp = await axios.post(`${this.agentUrl}/place-order`, agentPayload, { timeout: 15000 });
            return resp;
        } catch (err: any) {
            log.error(`[AGENT_ERROR] Failed to route to agent ${this.agentUrl}: ${err.message}`);
            throw err;
        }
    }

    // Direct route (default)
    return await this.authPost(jwtToken, "/rest/secure/angelbroking/order/v1/placeOrder", payload);
  }
}
