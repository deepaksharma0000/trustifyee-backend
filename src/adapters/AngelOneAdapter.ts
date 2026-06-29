import axios, { AxiosInstance } from "axios";
import https from "https";
import speakeasy from "speakeasy";
import { config } from "../config";
import log from "../utils/logger";
import { decrypt } from "../utils/encryption";
import { ipv4Agent } from "../utils/httpAgent";
import { getAngelNetworkIdentity } from "../utils/angelNetworkIdentity";
import { buildBrokerConnectionMetadata } from "../utils/apiKeyRouteBinding";
import { IBrokerAdapter } from "./IBrokerAdapter";
import { IUser } from "../models/User";

export type AngelSessionResp = {
  status?: boolean | string | number;
  message?: string;
  errorcode?: string;
  data?: any;
};

export class AngelOneAdapter implements IBrokerAdapter {
  private static shouldLogInit = process.env.LOG_ADAPTER_INIT === "true";
  private static localBindingEnabled = process.env.ANGEL_ENABLE_LOCAL_BINDING === "true";
  private static bindAgentCache = new Map<string, https.Agent>();
  private apiKey: string;
  private client: AxiosInstance;
  private outgoingIp?: string;
  private agentUrl?: string;
  private tokenPath = "/rest/auth/angelbroking/jwt/v1/generateTokens";
  private refreshTokenPath = "/rest/auth/angelbroking/jwt/v1/generateTokens";
  private legacyRefreshTokenPath = "/rest/auth/angelbroking/jwt/v1/refreshToken";
  private isDataAccount: boolean;

  private forcedBaseUrl = "https://apiconnect.angelone.in";
  private static IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;

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

  private normalizeIpv4(value?: string) {
    const ip = String(value || "").trim();
    return AngelOneAdapter.IPV4_REGEX.test(ip) ? ip : "";
  }

  private resolveHeaderIdentity() {
    const identity = getAngelNetworkIdentity();
    const configuredIp = this.normalizeIpv4(this.outgoingIp);
    const sharedIp = identity.publicIp;
    // When no dedicated route is configured, always advertise the VPS/shared IP in Angel headers.
    const publicIp = configuredIp || sharedIp;
    const localIp = configuredIp || identity.localIp || sharedIp;

    return {
      ...identity,
      publicIp,
      localIp,
    };
  }

  private baseHeaders(jwtToken?: string) {
    const { safeDecrypt } = require("../utils/encryption");
    const identity = this.resolveHeaderIdentity();

    const decApiKey = safeDecrypt(this.apiKey, "angel_adapter_headers");
    if (!decApiKey) throw new Error("Invalid decryption key. Access Denied.");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-UserType": identity.userType,
      "X-SourceID": identity.sourceId,
      "X-ClientLocalIP": identity.localIp,
      "X-ClientPublicIP": identity.publicIp,
      "X-MACAddress": identity.macAddress,
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
    const normalizedPath = String(path || "").toLowerCase();
    const usingDataAccount =
      this.isDataAccount || (Boolean(config.dataApiKey) && this.apiKey === config.dataApiKey);
    const isTradeMutationPath =
      normalizedPath.includes("/order/v1/placeorder") ||
      normalizedPath.includes("/order/v1/modifyorder") ||
      normalizedPath.includes("/order/v1/cancelorder");

    if (usingDataAccount && isTradeMutationPath) {
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
    try {
      return await this.client.post(this.refreshTokenPath, body, {
        headers: this.baseHeaders(),
      });
    } catch (err: any) {
      const status = Number(err?.response?.status || 0);
      if (!status || status < 500) {
        try {
          log.warn("[ANGEL_REFRESH_PATH_FALLBACK] Primary refresh path failed, trying legacy path", {
            primaryPath: this.refreshTokenPath,
            legacyPath: this.legacyRefreshTokenPath,
            status: status || undefined,
            message: err?.response?.data?.message || err?.message,
          });
          return await this.client.post(this.legacyRefreshTokenPath, body, {
            headers: this.baseHeaders(),
          });
        } catch {
          // preserve original error below
        }
      }
      throw err;
    }
  }

  async getProfile(jwtToken: string) {
    return this.authGet(jwtToken, "/rest/secure/angelbroking/user/v1/getProfile");
  }

  async getRMS(jwtToken: string) {
    return this.authGet(jwtToken, "/rest/secure/angelbroking/user/v1/getRMS");
  }

  async getOrderBook(token: string) {
    try {
      const resp = await this.authGet(token, "/rest/secure/angelbroking/order/v1/getOrderBook");
      log.info("FULL_BROKER_RESPONSE", {
        context: "angel_get_order_book",
        response: JSON.stringify(resp?.data ?? null, null, 2),
      });
      return resp;
    } catch (err: any) {
      log.error("[ANGEL_GET_ORDER_BOOK_FAILED]", {
        message: err?.message,
        response: err?.response?.data,
      });
      throw err;
    }
  }

  async getOrderStatus(token: string, orderId: string) {
    try {
      const resp = await this.authGet(token, `/rest/secure/angelbroking/order/v1/getOrderStatus/${orderId}`);
      log.info("FULL_BROKER_RESPONSE", {
        context: "angel_get_order_status",
        orderId,
        response: JSON.stringify(resp?.data ?? null, null, 2),
      });
      return resp;
    } catch (err: any) {
      log.error("[ANGEL_GET_ORDER_STATUS_FAILED]", {
        orderId,
        message: err?.message,
        response: err?.response?.data,
      });
      throw err;
    }
  }

  async searchScrip(token: string, exchange: string, searchtext: string) {
    return this.authPost(token, "/rest/secure/angelbroking/order/v1/searchScrip", {
      exchange,
      searchtext,
    });
  }

  async connect(user: IUser, authCodeOrCredentials: any): Promise<any> {
    const clientcode = authCodeOrCredentials.clientcode || user.broker_config?.clientCode;
    const password = authCodeOrCredentials.password;
    const totp = authCodeOrCredentials.totp;
    const totp_secret = authCodeOrCredentials.totp_secret || authCodeOrCredentials.totpSecret;

    const resp = await this.generateSession({
      clientcode,
      password,
      totp,
      totp_secret
    });

    if (resp && resp.data && resp.data.status === true) {
      const tokenData = resp.data.data;
      const { jwtToken, refreshToken, feedToken } = tokenData;

      const AngelTokensModel = require("../models/AngelTokens").default;
      const { encrypt } = require("../utils/encryption");

      await AngelTokensModel.findOneAndUpdate(
        { userId: user._id, clientcode },
        {
          userId: user._id,
          clientcode,
          jwtToken: encrypt(jwtToken),
          refreshToken: encrypt(refreshToken),
          feedToken: encrypt(feedToken),
          apiKey: encrypt(this.apiKey),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          ...buildBrokerConnectionMetadata({
            brokerName: "Angel One",
            apiKey: this.apiKey,
            clientCode: clientcode,
            outgoingIp: user.outgoing_ip,
            assignedExecutionIp: (user as any).assignedExecutionIp || user.outgoing_ip,
            agentUrl: user.agent_url,
            dedicatedIpEnabled: Boolean(user.dedicated_ip_enabled === true),
            brokerAppName:
              authCodeOrCredentials?.broker_app_name ||
              authCodeOrCredentials?.app_name ||
              authCodeOrCredentials?.appName ||
              user.broker_config?.appName,
            verificationStatus: "VERIFIED",
            connectionTimestamp: new Date(),
            brokerLoginTimestamp: new Date(),
          }),
        },
        { upsert: true, new: true }
      );

      const User = require("../models/User").default;
      const updateFields: any = {
        broker_connected: true,
        broker_verified: true,
        trading_paused: false,
        consecutive_failures: 0,
        broker: "AngelOne"
      };
      if (password) updateFields.broker_password = encrypt(password);
      if (totp_secret) updateFields.broker_totp_secret = encrypt(totp_secret);
      if (clientcode) updateFields.client_key = encrypt(clientcode);

      await User.updateOne({ _id: user._id }, { $set: updateFields });
    }
    return resp;
  }

  async refreshSession(user: IUser): Promise<any> {
    const AngelTokensModel = require("../models/AngelTokens").default;
    const sessionDoc = await AngelTokensModel.findOne({ userId: user._id });
    if (!sessionDoc) {
      throw new Error("No Angel session found to refresh");
    }
    const { recoverSessionByRefreshOrLogin } = require("../services/AngelSessionLifecycleService");
    return await recoverSessionByRefreshOrLogin(sessionDoc, "adapter_refresh");
  }

  async placeOrder(userOrToken: string | IUser, payload: any): Promise<any> {
    if (typeof userOrToken === "string") {
      const jwtToken = userOrToken;
      const isIpValid = Boolean(this.outgoingIp && String(this.outgoingIp).trim() !== "");
      const hasAgent = Boolean(this.agentUrl && String(this.agentUrl).trim() !== "");

      if (hasAgent && this.agentUrl) {
        const { safeDecrypt } = require("../utils/encryption");
        const decApiKey = safeDecrypt(this.apiKey, "agent_routing");
        const headerIdentity = this.resolveHeaderIdentity();

        const agentPayload = {
          secret: config.agentSecret,
          jwtToken: decrypt(jwtToken, "agent_routing_jwt"),
          apiKey: decApiKey,
          orderPayload: payload,
          clientPublicIp: headerIdentity.publicIp,
          clientLocalIp: headerIdentity.localIp,
          clientMacAddress: headerIdentity.macAddress,
          sourceId: headerIdentity.sourceId,
          userType: headerIdentity.userType,
        };

        try {
          const response = await axios.post(`${this.agentUrl}/place-order`, agentPayload, { timeout: 15000 });
          log.info("FULL_BROKER_RESPONSE", {
            context: "angel_place_order_agent",
            agentUrl: this.agentUrl,
            response: JSON.stringify(response?.data ?? null, null, 2),
          });
          return response;
        } catch (err: any) {
          log.error("[AGENT_ERROR] Failed order routing to agent", {
            agentUrl: this.agentUrl,
            message: err?.message,
            response: err?.response?.data,
          });
          throw err;
        }
      }

      const shouldAttemptLocalBind = AngelOneAdapter.localBindingEnabled && isIpValid && this.outgoingIp;

      if (shouldAttemptLocalBind && this.outgoingIp) {
        const bindKey = this.outgoingIp.trim();
        let bindingAgent = AngelOneAdapter.bindAgentCache.get(bindKey);

        if (!bindingAgent) {
          bindingAgent = new https.Agent({
            family: 4,
            localAddress: bindKey,
            keepAlive: true,
            timeout: 60000,
          });
          AngelOneAdapter.bindAgentCache.set(bindKey, bindingAgent);
        }

        try {
          const response = await axios.post(
            `${this.forcedBaseUrl}/rest/secure/angelbroking/order/v1/placeOrder`,
            payload,
            {
              headers: this.baseHeaders(jwtToken),
              httpsAgent: bindingAgent,
              timeout: 60000,
            }
          );
          log.info("FULL_BROKER_RESPONSE", {
            context: "angel_place_order_local_bind",
            outgoingIp: this.outgoingIp || "",
            response: JSON.stringify(response?.data ?? null, null, 2),
          });
          return response;
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

      if (!hasAgent && !this.isDataAccount && !AngelOneAdapter.localBindingEnabled) {
        log.debug("[ORDER_NETWORK] Local address binding disabled. Using VPS default route.");
      } else if (!isIpValid && !hasAgent && !this.isDataAccount) {
        log.warn("[ORDER_NETWORK_FALLBACK] No dedicated IP/agent provided. Using server network route.");
      }

      try {
        const resp = await this.authPost(jwtToken, "/rest/secure/angelbroking/order/v1/placeOrder", payload);
        log.info("FULL_BROKER_RESPONSE", {
          context: "angel_place_order",
          response: JSON.stringify(resp?.data ?? null, null, 2),
        });
        return resp;
      } catch (err: any) {
        log.error("[ANGEL_PLACE_ORDER_FAILED]", {
          message: err?.message,
          response: err?.response?.data,
        });
        throw err;
      }
    } else {
      const { getIsolatedAngelSession } = require("../services/AngelUserSessionManager");
      const session = await getIsolatedAngelSession({
        userId: String(userOrToken._id),
        clientcode: userOrToken.broker_config?.clientCode || "",
        purpose: "order_place"
      });
      return this.placeOrder(session.jwtToken, payload);
    }
  }

  async modifyOrder(userOrToken: string | IUser, orderId: string, payload: any): Promise<any> {
    if (typeof userOrToken === "string") {
      const fullPayload = { ...payload, orderid: orderId };
      return this.authPost(userOrToken, "/rest/secure/angelbroking/order/v1/modifyOrder", fullPayload);
    } else {
      const { getIsolatedAngelSession } = require("../services/AngelUserSessionManager");
      const session = await getIsolatedAngelSession({
        userId: String(userOrToken._id),
        clientcode: userOrToken.broker_config?.clientCode || "",
        purpose: "order_modify"
      });
      return this.modifyOrder(session.jwtToken, orderId, payload);
    }
  }

  async cancelOrder(userOrToken: string | IUser, orderId: string, payload?: any): Promise<any> {
    if (typeof userOrToken === "string") {
      const fullPayload = { ...payload, orderid: orderId };
      return this.authPost(userOrToken, "/rest/secure/angelbroking/order/v1/cancelOrder", fullPayload);
    } else {
      const { getIsolatedAngelSession } = require("../services/AngelUserSessionManager");
      const session = await getIsolatedAngelSession({
        userId: String(userOrToken._id),
        clientcode: userOrToken.broker_config?.clientCode || "",
        purpose: "order_cancel"
      });
      return this.cancelOrder(session.jwtToken, orderId, payload);
    }
  }

  async getPositions(userOrToken: string | IUser): Promise<any> {
    if (typeof userOrToken === "string") {
      try {
        const resp = await this.authGet(userOrToken, "/rest/secure/angelbroking/order/v1/getPosition");
        log.info("FULL_BROKER_RESPONSE", {
          context: "angel_get_positions",
          response: JSON.stringify(resp?.data ?? null, null, 2),
        });
        return resp;
      } catch (err: any) {
        log.error("[ANGEL_GET_POSITIONS_FAILED]", {
          message: err?.message,
          response: err?.response?.data,
        });
        throw err;
      }
    } else {
      const { getIsolatedAngelSession } = require("../services/AngelUserSessionManager");
      const session = await getIsolatedAngelSession({
        userId: String(userOrToken._id),
        clientcode: userOrToken.broker_config?.clientCode || "",
        purpose: "get_positions"
      });
      return this.getPositions(session.jwtToken);
    }
  }

  async getHoldings(userOrToken: string | IUser): Promise<any> {
    if (typeof userOrToken === "string") {
      return this.authGet(userOrToken, "/rest/secure/angelbroking/portfolio/v1/getHolding");
    } else {
      const { getIsolatedAngelSession } = require("../services/AngelUserSessionManager");
      const session = await getIsolatedAngelSession({
        userId: String(userOrToken._id),
        clientcode: userOrToken.broker_config?.clientCode || "",
        purpose: "get_holdings"
      });
      return this.getHoldings(session.jwtToken);
    }
  }

  async getFunds(userOrToken: string | IUser): Promise<any> {
    if (typeof userOrToken === "string") {
      return this.getRMS(userOrToken);
    } else {
      const { getIsolatedAngelSession } = require("../services/AngelUserSessionManager");
      const session = await getIsolatedAngelSession({
        userId: String(userOrToken._id),
        clientcode: userOrToken.broker_config?.clientCode || "",
        purpose: "get_funds"
      });
      return this.getRMS(session.jwtToken);
    }
  }

  async getOrders(userOrToken: string | IUser): Promise<any> {
    if (typeof userOrToken === "string") {
      return this.getOrderBook(userOrToken);
    } else {
      const { getIsolatedAngelSession } = require("../services/AngelUserSessionManager");
      const session = await getIsolatedAngelSession({
        userId: String(userOrToken._id),
        clientcode: userOrToken.broker_config?.clientCode || "",
        purpose: "get_orders"
      });
      return this.getOrderBook(session.jwtToken);
    }
  }

  async logout(user: IUser): Promise<any> {
    const AngelTokensModel = require("../models/AngelTokens").default;
    await AngelTokensModel.deleteOne({ userId: user._id });
    const User = require("../models/User").default;
    await User.updateOne(
      { _id: user._id },
      { $set: { broker_connected: false, broker_verified: false } }
    );
    return { status: true, message: "Logged out successfully" };
  }
}
