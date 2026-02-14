import axios, { AxiosInstance } from "axios";
import { config } from "../config";
import { log } from "../utils/logger";
import { decrypt } from "../utils/encryption";

export interface UpstoxTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  extended_token?: string;
  user_id: string;
  email: string;
  user_name: string;
  exchanges: string[];
  products: string[];
  order_types: string[];
}


export type UpstoxSessionResp = {
  status?: boolean | string;
  message?: string;
  errorcode?: string;
  data?: any;
};


export class UpstoxAdapter {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  private apiKey: string;
  private client: AxiosInstance;

  constructor() {
    this.clientId = config.upstoxClientId;
    this.clientSecret = config.upstoxApiSecret;
    this.redirectUri = config.upstoxRedirectUri;
    this.apiKey = config.upstoxApiKey;

    this.client = axios.create({
      baseURL: "https://api.upstox.com/v2",
      timeout: 15000,
    });
    // Add debug logging to verify configuration

    log.debug("UpstoxAdapter initialized:", {
      clientId: this.clientId ? "***" + this.clientId.slice(-4) : "MISSING",
      redirectUri: this.redirectUri
    });

  }


  /**
   * Generate authorization URL for user login
   */
  getAuthUrl(state: string = "default"): string {
    if (!this.clientId) {
      throw new Error("Upstox Client ID is not configured");
    }
    if (!this.redirectUri) {
      throw new Error("Upstox Redirect URI is not configured");
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      state: state,
    });

    const authUrl = `https://api.upstox.com/v2/login/authorization/dialog?${params.toString()}`;

    log.debug("Generated Upstox auth URL", {
      state,
      redirectUri: this.redirectUri,
      urlLength: authUrl.length
    });
    // return authUrl;


    return `https://api.upstox.com/v2/login/authorization/dialog?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code: string): Promise<UpstoxTokenResponse> {
    if (!this.clientSecret) {
      throw new Error("Upstox Client Secret is not configured");
    }
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code: code,
      redirect_uri: this.redirectUri,
      grant_type: "authorization_code",
    });
    log.debug("Exchanging authorization code for token", {
      codePresent: !!code,
      clientIdPresent: !!this.clientId,
      clientSecretPresent: !!this.clientSecret,
      redirectUri: this.redirectUri
    });

    try {
      log.debug("Exchanging code for token with Upstox...");

      const response = await this.client.post("/login/authorization/token", body, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
        },
      });

      log.debug("Upstox token exchange successful");
      return response.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data;

      log.error("Upstox token exchange failed:", {
        status,
        errorCode: data?.errors?.[0]?.errorCode,
        message: data?.errors?.[0]?.message,
        clientIdConfigured: !!this.clientId,
        clientSecretConfigured: !!this.clientSecret,
        redirectUri: this.redirectUri
      });
      const errorMessage = data?.errors?.[0]?.message || "Authentication failed";
      throw new Error(`Upstox login failed: ${errorMessage}`);

      throw new Error(
        `Token exchange failed [${status}]: ${JSON.stringify(data)}`
      );
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<UpstoxTokenResponse> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: decrypt(refreshToken),
      grant_type: "refresh_token",
    });

    try {
      const response = await this.client.post("/login/authorization/token", body, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
        },
      });

      log.debug("Upstox token refresh successful");
      return response.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data;

      log.error("Upstox token refresh failed:", {
        status,
        error: data,
        message: err.message
      });

      throw new Error(
        `Token refresh failed [${status}]: ${JSON.stringify(data)}`
      );
    }
  }

  /**
   * Get user profile information
   */
  async getUserProfile(accessToken: string) {
    try {
      const response = await this.client.get("/user/profile", {
        headers: {
          "Authorization": `Bearer ${decrypt(accessToken)}`,
          "Accept": "application/json",
        },
      });

      return response.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data;

      log.error("Get user profile failed:", {
        status,
        error: data,
        message: err.message
      });

      throw new Error(
        `Get profile failed [${status}]: ${JSON.stringify(data)}`
      );
    }
  }

  /**
   * Validate token and get user details
   */
  async validateToken(accessToken: string) {
    try {
      const response = await this.client.get("/user/profile", {
        headers: {
          "Authorization": `Bearer ${decrypt(accessToken)}`,
          "Accept": "application/json",
        },
      });

      return {
        isValid: true,
        userData: response.data
      };
    } catch (err: any) {
      return {
        isValid: false,
        error: err.message
      };
    }
  }

  /**
   * Generic authenticated API call
   */
  async authGet(accessToken: string, endpoint: string, params?: any) {
    try {
      const response = await this.client.get(endpoint, {
        headers: {
          "Authorization": `Bearer ${decrypt(accessToken)}`,
          "Accept": "application/json",
        },
        params,
      });

      return response.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data;

      log.error(`Upstox API call failed [${endpoint}]:`, {
        status,
        error: data,
        message: err.message
      });

      throw new Error(
        `API call failed [${status}]: ${JSON.stringify(data)}`
      );
    }
  }

  /**
   * Generic authenticated POST call
   */
  async authPost(accessToken: string, endpoint: string, data?: any) {
    try {
      const response = await this.client.post(endpoint, data, {
        headers: {
          "Authorization": `Bearer ${decrypt(accessToken)}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
      });

      return response.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data;

      log.error(`Upstox API POST call failed [${endpoint}]:`, {
        status,
        error: data,
        message: err.message
      });

      throw new Error(
        `API POST call failed [${status}]: ${JSON.stringify(data)}`
      );
    }
  }

  /**
 * Get instrument info from Upstox API
 * NOTE: adjust path if Upstox endpoint differs in your account.
 */
  async getInstrumentInfo(accessToken: string, instrumentToken: string) {
    if (!instrumentToken) throw new Error("instrumentToken required");
    // Example path — change to actual Upstox path if needed
    const path = "/v2/instruments/info";
    return this.authGet(accessToken, path, { instrument_token: instrumentToken });
  }

  /**
   * Bulk fetch instruments (for example search or list)
   * `params` will be passed as query params.
   */
  async searchInstruments(accessToken: string, params?: any) {
    // Endpoint may differ — some Upstox APIs provide /v2/instruments/search or /v2/instruments
    const path = "/v2/instruments/search";
    return this.authGet(accessToken, path, params);
  }

  /**
   * Optionally: fetch all instruments dump (if available)
   * Many brokers provide a bulk instruments file/endpoint — you can implement
   * a streaming/bulk importer here. Placeholder below:
   */
  async fetchAllInstruments(accessToken: string) {
    const path = "/v2/instruments"; // replace with actual bulk endpoint if available
    return this.authGet(accessToken, path);
  }
  async placeOrder(accessToken: string, order: any) {
    const path = "/v2/order/place";
    return this.authPost(accessToken, path, {
      quantity: order.quantity,
      product: order.product,
      validity: order.validity,
      price: order.price,
      tag: order.tag || "my-bot",
      instrument_token: order.instrument_token,
      order_type: order.order_type,
      transaction_type: order.transaction_type,
      disclosed_quantity: order.disclosed_quantity ?? 0,
      trigger_price: order.trigger_price ?? 0,
      is_amo: order.is_amo ?? false
    });
  }
  // async getOrderStatus(accessToken: string, orderId: string) {
  //   const path = "/v2/order/details";
  //   return this.authGet(path, accessToken, { order_id: orderId });
  // }
  async getOrderStatus(accessToken: string, orderId: string) {
    const path = "/order/details"; // baseURL already /v2
    return this.authGet(accessToken, path, { order_id: orderId });
  }

  async getOrderBook(accessToken: string) {
    const path = "/v2/order/retrieve-all";
    return this.authGet(path, accessToken);
  }
  async fetchOptionContract(accessToken: string, instrumentKey: string) {
    if (!accessToken) throw new Error("accessToken required");
    if (!instrumentKey) throw new Error("instrumentKey required");

    const endpoint = "/option/contract";

    try {
      // note: authGet(accessToken, endpoint, params) matches your src signature
      const resp = await this.authGet(accessToken, endpoint, { instrument_key: instrumentKey });
      return resp;
    } catch (err: any) {
      // use shared logger imported at top of file
      log.error("fetchOptionContract failed", err?.response?.data || err.message || err);
      throw err;
    }
  }


  // class UpstoxAdapter ke andar add karo

  async getLtp(accessToken: string, instrumentKeys: string | string[]) {
    const instrument_key = Array.isArray(instrumentKeys)
      ? instrumentKeys.join(",")
      : instrumentKeys;

    // yaha pe endpoint v2 baseURL pe relative hai
    return this.authGet(accessToken, "/market-quote/ltp", { instrument_key });
  }

}
