"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AliceBlueAdapter = void 0;
// src/adapters/AliceBlueAdapter.ts
const axios_1 = __importDefault(require("axios"));
const zlib_1 = __importDefault(require("zlib"));
const crypto_1 = __importDefault(require("crypto"));
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
class AliceBlueAdapter {
    constructor() {
        this.clientId = config_1.config.aliceClientId;
        this.apiKey = ""; // config.aliceApiKey;  // agar ab apiKey nahi chahiye to blank rakho
        // ye client pure tumhare existing order APIs ke liye hai
        this.client = axios_1.default.create({
            baseURL: config_1.config.aliceOrderBaseUrl, // https://a3.aliceblueonline.com/
            timeout: 15000
        });
        this.placeOrderPath = config_1.config.alicePlaceOrderPath;
        this.orderStatusPath = config_1.config.aliceOrderStatusPath;
        // NEW: vendor auth config
        this.appCode = config_1.config.aliceAppCode;
        this.apiSecret = config_1.config.aliceApiSecret;
        this.authBaseUrl = config_1.config.aliceAuthBaseUrl;
        this.getUserDetailsPath = config_1.config.aliceGetUserDetailsPath;
    }
    // ----------------- COMMON HEADERS FOR ORDER/APIs -----------------
    baseHeaders(sessionId) {
        const headers = {
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
    async authPost(sessionId, path, body) {
        try {
            const resp = await this.client.post(path, body || {}, {
                headers: this.baseHeaders(sessionId)
            });
            return resp.data;
        }
        catch (err) {
            const status = err?.response?.status;
            const data = err?.response?.data ?? err.message;
            logger_1.log.error("Alice authPost error status:", status);
            logger_1.log.error("Alice authPost error body:", JSON.stringify(data, null, 2));
            logger_1.log.error("Alice authPost raw error:", err?.toString?.() || err);
            throw new Error(`Alice authPost error [${status}]: ${JSON.stringify(data)}`);
        }
    }
    async authGet(sessionId, path, params) {
        try {
            const resp = await this.client.get(path, {
                headers: this.baseHeaders(sessionId),
                params
            });
            return resp.data;
        }
        catch (err) {
            const status = err?.response?.status;
            const data = err?.response?.data ?? err.message;
            logger_1.log.error("Alice authGet error status:", status);
            logger_1.log.error("Alice authGet error body:", JSON.stringify(data, null, 2));
            logger_1.log.error("Alice authGet raw error:", err?.toString?.() || err);
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
    getLoginUrl(state) {
        const url = new URL(this.authBaseUrl + "/");
        url.searchParams.set("appcode", this.appCode);
        if (state) {
            url.searchParams.set("state", state);
        }
        return url.toString();
    }
    // helper checksum
    buildChecksum(userId, authCode) {
        return crypto_1.default
            .createHash("sha256")
            .update(userId + authCode + this.apiSecret)
            .digest("hex");
    }
    /**
     * docs ke hisaab se:
     * POST https://ant.aliceblueonline.com/open-api/od/v1/vendor/getUserDetails
     * Body: { "checkSum": "<sha256(userId+authCode+apiSecret)>" }
     */
    async getSessionFromAuthCode(authCode, userId) {
        const checksum = this.buildChecksum(userId, authCode);
        const url = this.authBaseUrl.replace(/\/$/, "") + this.getUserDetailsPath;
        try {
            const resp = await axios_1.default.post(url, { checkSum: checksum }, {
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json"
                }
            });
            return resp.data;
        }
        catch (err) {
            const status = err?.response?.status;
            const data = err?.response?.data ?? err.message;
            logger_1.log.error("Alice getSessionFromAuthCode error status:", status);
            logger_1.log.error("Alice getSessionFromAuthCode error body:", JSON.stringify(data, null, 2));
            logger_1.log.error("Alice getSessionFromAuthCode raw error:", err?.toString?.() || err);
            throw new Error(`Alice getSessionFromAuthCode error [${status}]: ${JSON.stringify(data)}`);
        }
    }
    // =========================================================
    //  EXISTING PART: PLACE ORDER / ORDER STATUS
    //  (as-is rakha hai, sirf thoda cleanup)
    // =========================================================
    async placeOrder(sessionId, order) {
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
                price: order.ordertype === "MARKET"
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
    async getOrderStatus(sessionId, orderId) {
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
    async getContractMasterForExchange(exchange) {
        let url;
        switch (exchange.toUpperCase()) {
            case "NSE":
                url = config_1.config.aliceContractMasterNseUrl;
                break;
            case "NFO":
                url = config_1.config.aliceContractMasterNfoUrl;
                break;
            case "INDICES":
            case "INDEX":
                url = config_1.config.aliceContractMasterIndicesUrl;
                break;
            default:
                throw new Error(`Unsupported Alice contract master exchange: ${exchange}`);
        }
        if (!url) {
            throw new Error(`Contract master URL not configured for exchange=${exchange}. Check your env variables.`);
        }
        logger_1.log.info(`Fetching Alice contract master from: ${url}`);
        const resp = await axios_1.default.get(url, {
            responseType: "arraybuffer"
        });
        const contentType = (resp.headers["content-type"] || "").toLowerCase();
        const buffer = Buffer.from(resp.data);
        // 1) Agar HTML aaya -> URL galat hai
        const asTextPreview = buffer.toString("utf8", 0, 100).trim();
        if (asTextPreview.startsWith("<!doctype html") || asTextPreview.startsWith("<html")) {
            logger_1.log.error("Alice contract master returned HTML. URL is likely wrong or not API.");
            logger_1.log.error("Preview:", asTextPreview);
            throw new Error(`Contract master URL is not returning JSON. Check URL: ${url}`);
        }
        let text;
        // 2) Agar JSON directly aaya
        if (contentType.includes("application/json")) {
            text = buffer.toString("utf8");
        }
        // 3) Agar zip/gzip ya octet-stream aaya (NFO.zip, NSE.zip)
        else if (contentType.includes("application/zip") ||
            contentType.includes("application/octet-stream") ||
            contentType.includes("gzip")) {
            try {
                const unzipped = zlib_1.default.unzipSync(buffer); // works for zip/gz in most cases
                text = unzipped.toString("utf8");
            }
            catch (e) {
                logger_1.log.error("Failed to unzip contract master:", e?.message || e);
                // last fallback
                text = buffer.toString("utf8");
            }
        }
        else {
            // Unknown, try plain text
            text = buffer.toString("utf8");
        }
        let json;
        try {
            json = JSON.parse(text);
        }
        catch (e) {
            logger_1.log.error("Failed to parse contract master JSON. First 200 chars:");
            logger_1.log.error(text.slice(0, 200));
            throw new Error(`Contract master response is not valid JSON. Check URL or version.`);
        }
        if (Array.isArray(json)) {
            logger_1.log.info(`Contract master JSON is an array with ${json.length} rows`);
            return json;
        }
        if (json && Array.isArray(json.data)) {
            logger_1.log.info(`Contract master JSON has data[] array with ${json.data.length} rows`);
            return json.data;
        }
        if (json && Array.isArray(json.result)) {
            logger_1.log.info(`Contract master JSON has result[] array with ${json.result.length} rows`);
            return json.result;
        }
        // NEW: generic object-of-objects handling
        if (json && typeof json === "object") {
            const values = Object.values(json);
            logger_1.log.info(`Contract master JSON is an object. Converted to array with ${values.length} rows (Object.values).`);
            return values;
        }
        logger_1.log.error("Unknown contract master JSON structure:", json);
        throw new Error("Unexpected contract master JSON structure");
    }
}
exports.AliceBlueAdapter = AliceBlueAdapter;
