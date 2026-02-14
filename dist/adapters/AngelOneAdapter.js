"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AngelOneAdapter = void 0;
// src/adapters/AngelOneAdapter.ts
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
class AngelOneAdapter {
    constructor() {
        // official SmartAPI paths
        this.loginPath = "/rest/auth/angelbroking/user/v1/loginByPassword";
        this.tokenPath = "/rest/auth/angelbroking/jwt/v1/generateTokens";
        this.refreshTokenPath = "/rest/auth/angelbroking/jwt/v1/refreshToken";
        this.apiKey = config_1.config.angelApiKey;
        this.client = axios_1.default.create({
            baseURL: config_1.config.angelBaseUrl,
            timeout: 15000
        });
        this.tokenPath = config_1.config.genPath || this.tokenPath;
        this.refreshTokenPath = config_1.config.refreshPath || this.refreshTokenPath;
    }
    // common headers
    baseHeaders(jwtToken) {
        const headers = {
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
    async generateSession(params) {
        const body = {
            clientcode: params.clientcode,
            password: params.password,
            totp: params.totp || ""
        };
        try {
            const resp = await this.client.post(this.loginPath, body, {
                headers: this.baseHeaders()
            });
            logger_1.log.debug("Angel loginByPassword response:", resp.data);
            return resp.data;
        }
        catch (err) {
            const status = err?.response?.status;
            const data = err?.response?.data || err.message;
            logger_1.log.error("generateSession failed", status, data);
            throw new Error(`generateSession failed: ${JSON.stringify(data)}`);
        }
    }
    // ------------ GENERIC AUTHP POST / GET ------------
    async authPost(jwtToken, path, body) {
        try {
            const resp = await this.client.post(path, body || {}, {
                headers: this.baseHeaders(jwtToken)
            });
            return resp.data;
        }
        catch (err) {
            const status = err?.response?.status;
            const data = err?.response?.data ?? err.message;
            if (status !== 403 && status !== 429) {
                logger_1.log.error("authPost error status:", status);
                logger_1.log.error("authPost error body:", JSON.stringify(data, null, 2));
                logger_1.log.error("authPost raw error:", err?.toString?.() || err);
            }
            throw new Error(`authPost error [${status}]: ${JSON.stringify(data)}`);
        }
    }
    async authGet(jwtToken, path, params) {
        try {
            const resp = await this.client.get(path, {
                headers: this.baseHeaders(jwtToken),
                params
            });
            return resp.data;
        }
        catch (err) {
            const status = err?.response?.status;
            const data = err?.response?.data ?? err.message;
            logger_1.log.error("authGet error status:", status);
            logger_1.log.error("authGet error body:", JSON.stringify(data, null, 2));
            logger_1.log.error("authGet raw error:", err?.toString?.() || err);
            throw new Error(`authGet error [${status}]: ${JSON.stringify(data)}`);
        }
    }
    // ------------ PLACE ORDER (optional direct use) ------------
    async placeOrder(jwtToken, order) {
        const path = "/rest/secure/angelbroking/order/v1/placeOrder";
        if (!order.symboltoken) {
            throw new Error("symboltoken is required for placeOrder (AngelOne needs instrument token).");
        }
        const payload = {
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
    async getOrderStatus(jwtToken, brokerOrderId) {
        const path = `/rest/secure/angelbroking/order/v1/getOrder?orderId=${encodeURIComponent(brokerOrderId)}`;
        return await this.authGet(jwtToken, path);
    }
    // ------------ LTP / MARKET DATA ------------
    async getLtp(jwtToken, exchange, tradingsymbol, symboltoken) {
        const path = "/rest/secure/angelbroking/order/v1/getLtpData";
        const body = {
            exchange,
            tradingsymbol,
            symboltoken
        };
        return await this.authPost(jwtToken, path, body);
    }
    // ------------ REFRESH TOKEN (OPTIONAL) ------------
    async generateTokensUsingRefresh(refreshToken) {
        const body = { refreshToken };
        try {
            const resp = await this.client.post(this.refreshTokenPath, body, {
                headers: this.baseHeaders()
            });
            return resp.data;
        }
        catch (err) {
            const data = err?.response?.data || err.message;
            logger_1.log.error("generateTokensUsingRefresh failed", data);
            throw new Error(`generateTokensUsingRefresh failed: ${JSON.stringify(data)}`);
        }
    }
    // ------------ USER PROFILE ------------
    async getProfile(jwtToken) {
        const path = "/rest/secure/angelbroking/user/v1/getProfile";
        try {
            const resp = await this.client.get(path, {
                headers: this.baseHeaders(jwtToken)
            });
            return resp.data;
        }
        catch (err) {
            // Return error structure rather than throwing for easier validation check
            const data = err?.response?.data ?? err.message;
            return { status: false, message: "Profile fetch failed", data };
        }
    }
}
exports.AngelOneAdapter = AngelOneAdapter;
