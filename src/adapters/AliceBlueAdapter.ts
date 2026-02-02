// src/adapters/AliceBlueAdapter.ts
import axios, { AxiosInstance } from "axios";
import zlib from "zlib";
import crypto from "crypto";
import { config } from "../config";
import { log } from "../utils/logger";

export class AliceBlueAdapter {
  private clientId: string;
  private apiKey: string;
  private client: AxiosInstance;
  private placeOrderPath: string;
  private orderStatusPath: string;

  // NEW: auth (vendor) config
  private appCode: string;
  private apiSecret: string;
  private authBaseUrl: string;
  private getUserDetailsPath: string;

  constructor() {
    this.clientId = config.aliceClientId;
    this.apiKey = ""; // config.aliceApiKey;  // agar ab apiKey nahi chahiye to blank rakho

    // ye client pure tumhare existing order APIs ke liye hai
    this.client = axios.create({
      baseURL: config.aliceOrderBaseUrl, // https://a3.aliceblueonline.com/
      timeout: 15000
    });

    this.placeOrderPath = config.alicePlaceOrderPath;
    this.orderStatusPath = config.aliceOrderStatusPath;

    // NEW: vendor auth config
    this.appCode = config.aliceAppCode;
    this.apiSecret = config.aliceApiSecret;
    this.authBaseUrl = config.aliceAuthBaseUrl;
    this.getUserDetailsPath = config.aliceGetUserDetailsPath;
  }

  // ----------------- COMMON HEADERS FOR ORDER/APIs -----------------

  private baseHeaders(sessionId?: string) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json"
    };

    // agar tum abhi bhi apiKey use karna chahte ho to yaha rakho
    if (this.apiKey) {
      headers["apikey"] = this.apiKey;
    }

    if (sessionId) {
      headers["Authorization"] = `Bearer ${sessionId}`;
    }

    return headers;
  }

  async authPost(sessionId: string, path: string, body?: any) {
    try {
      const resp = await this.client.post(path, body || {}, {
        headers: this.baseHeaders(sessionId)
      });
      return resp.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data ?? err.message;

      log.error("Alice authPost error status:", status);
      log.error("Alice authPost error body:", JSON.stringify(data, null, 2));
      log.error("Alice authPost raw error:", err?.toString?.() || err);

      throw new Error(`Alice authPost error [${status}]: ${JSON.stringify(data)}`);
    }
  }

  async authGet(sessionId: string, path: string, params?: any) {
    try {
      const resp = await this.client.get(path, {
        headers: this.baseHeaders(sessionId),
        params
      });
      return resp.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data ?? err.message;

      log.error("Alice authGet error status:", status);
      log.error("Alice authGet error body:", JSON.stringify(data, null, 2));
      log.error("Alice authGet raw error:", err?.toString?.() || err);

      throw new Error(`Alice authGet error [${status}]: ${JSON.stringify(data)}`);
    }
  }

  // =========================================================
  //  NEW PART 1: LOGIN URL (REDIRECT FLOW)
  // =========================================================

  /**
   * Frontend ko ye URL doge, use ispe redirect karwana hai
   * Optional `state` me tum clientcode bhej sakte ho
   */
  getLoginUrl(state?: string): string {
    const url = new URL(this.authBaseUrl + "/");
    url.searchParams.set("appcode", this.appCode);
    if (state) {
      url.searchParams.set("state", state);
    }
    return url.toString();
  }

  // helper checksum
  private buildChecksum(userId: string, authCode: string): string {
    return crypto
      .createHash("sha256")
      .update(userId + authCode + this.apiSecret)
      .digest("hex");
  }

  /**
   * docs ke hisaab se:
   * POST https://ant.aliceblueonline.com/open-api/od/v1/vendor/getUserDetails
   * Body: { "checkSum": "<sha256(userId+authCode+apiSecret)>" }
   */
  async getSessionFromAuthCode(authCode: string, userId: string) {
    const checksum = this.buildChecksum(userId, authCode);

    const url =
      this.authBaseUrl.replace(/\/$/, "") + this.getUserDetailsPath;

    try {
      const resp = await axios.post(url, { checkSum: checksum }, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      });

      return resp.data as {
        stat: "Ok" | "Not_ok";
        clientId?: string;
        userSession?: string;
        emsg?: string;
        userId?: string;
      };
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data ?? err.message;

      log.error("Alice getSessionFromAuthCode error status:", status);
      log.error("Alice getSessionFromAuthCode error body:", JSON.stringify(data, null, 2));
      log.error("Alice getSessionFromAuthCode raw error:", err?.toString?.() || err);

      throw new Error(
        `Alice getSessionFromAuthCode error [${status}]: ${JSON.stringify(data)}`
      );
    }
  }

  // =========================================================
  //  EXISTING PART: PLACE ORDER / ORDER STATUS
  //  (as-is rakha hai, sirf thoda cleanup)
  // =========================================================

  async placeOrder(
    sessionId: string,
    order: {
      exchange: string;              // "NSE"
      tradingsymbol: string;         // "RELIANCE-EQ"
      transactiontype: "BUY" | "SELL";
      quantity: number;
      ordertype?: "MARKET" | "LIMIT" | "SL" | "SLM";
      price?: number;
      producttype?: string;          // INTRADAY / LONGTERM / CNC etc.
      duration?: string;             // DAY / IOC
      symboltoken?: string;          // yahi instrumentId banega
      triggerPrice?: number;
    }
  ) {
    const payload = [
      {
        exchange: order.exchange,
        instrumentId: order.symboltoken,
        transactionType: order.transactiontype,
        quantity: order.quantity,
        product: order.producttype ?? "INTRADAY",
        orderComplexity: "REGULAR",
        orderType: order.ordertype ?? "MARKET",
        validity: order.duration ?? "DAY",
        price:
          order.ordertype === "MARKET"
            ? ""
            : String(order.price ?? ""),
        slTriggerPrice: order.triggerPrice
          ? String(order.triggerPrice)
          : "",
        disclosedQuantity: "",
        marketProtectionPercent: "",
        deviceId: "123",
        trailingSlAmount: "",
        apiOrderSource: "",
        algoId: "",
        orderTag: ""
      }
    ];

    return await this.authPost(sessionId, this.placeOrderPath, payload);
  }

  async getOrderStatus(sessionId: string, orderId: string) {
    const body = { brokerOrderId: orderId };
    return await this.authPost(sessionId, this.orderStatusPath, body);
  }

  



    // type approx, actual fields docs ke hisaab se adjust karna
  // async getContractMaster(sessionId: string,params: { exchange: string }) 
  // {
  //   const path = config.aliceContractMasterPath;
  //   const data = await this.authGet(sessionId, path, {
  //     exchange: params.exchange
  //   });

  //   return data;
  // }
  
    /**
   * Contract master JSON/ZIP download per-exchange.
   * Ye static URLs use karega (NSE/NFO/INDICES) - .env se aayenge.
   * Isme sessionId zaroori nahi hai, kyunki yeh public downloads hote hain.
   */
  async getContractMasterForExchange(exchange: string): Promise<any[]> {
    let url: string | undefined;

    switch (exchange.toUpperCase()) {
      case "NSE":
        url = config.aliceContractMasterNseUrl;
        break;
      case "NFO":
        url = config.aliceContractMasterNfoUrl;
        break;
      case "INDICES":
      case "INDEX":
        url = config.aliceContractMasterIndicesUrl;
        break;
      default:
        throw new Error(`Unsupported Alice contract master exchange: ${exchange}`);
    }

    if (!url) {
      throw new Error(
        `Contract master URL not configured for exchange=${exchange}. Check your env variables.`
      );
    }

    log.info(`Fetching Alice contract master from: ${url}`);

    const resp = await axios.get(url, {
      responseType: "arraybuffer"
    });

    const contentType = (resp.headers["content-type"] || "").toLowerCase();
    const buffer: Buffer = Buffer.from(resp.data);

    // 1) Agar HTML aaya -> URL galat hai
    const asTextPreview = buffer.toString("utf8", 0, 100).trim();
    if (asTextPreview.startsWith("<!doctype html") || asTextPreview.startsWith("<html")) {
      log.error("Alice contract master returned HTML. URL is likely wrong or not API.");
      log.error("Preview:", asTextPreview);
      throw new Error(
        `Contract master URL is not returning JSON. Check URL: ${url}`
      );
    }

    let text: string;

    // 2) Agar JSON directly aaya
    if (contentType.includes("application/json")) {
      text = buffer.toString("utf8");
    }
    // 3) Agar zip/gzip ya octet-stream aaya (NFO.zip, NSE.zip)
    else if (
      contentType.includes("application/zip") ||
      contentType.includes("application/octet-stream") ||
      contentType.includes("gzip")
    ) {
      try {
        const unzipped = zlib.unzipSync(buffer); // works for zip/gz in most cases
        text = unzipped.toString("utf8");
      } catch (e: any) {
        log.error("Failed to unzip contract master:", e?.message || e);
        // last fallback
        text = buffer.toString("utf8");
      }
    } else {
      // Unknown, try plain text
      text = buffer.toString("utf8");
    }

    let json: any;
    try {
      json = JSON.parse(text);
    } catch (e: any) {
      log.error("Failed to parse contract master JSON. First 200 chars:");
      log.error(text.slice(0, 200));
      throw new Error(
        `Contract master response is not valid JSON. Check URL or version.`
      );
    }

    if (Array.isArray(json)) {
      log.info(`Contract master JSON is an array with ${json.length} rows`);
      return json;
    }
    if (json && Array.isArray(json.data)) {
      log.info(
        `Contract master JSON has data[] array with ${json.data.length} rows`
      );
      return json.data;
    }
    if (json && Array.isArray(json.result)) {
      log.info(
        `Contract master JSON has result[] array with ${json.result.length} rows`
      );
      return json.result;
    }

     // NEW: generic object-of-objects handling
    if (json && typeof json === "object") {
      const values = Object.values(json);
      log.info(
        `Contract master JSON is an object. Converted to array with ${values.length} rows (Object.values).`
      );
      return values;
    }

    log.error("Unknown contract master JSON structure:", json);
    throw new Error("Unexpected contract master JSON structure");
  }

}
