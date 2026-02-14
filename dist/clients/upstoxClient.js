"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.upstoxApi = exports.createUpstoxClient = void 0;
exports.placeUpstoxOrder = placeUpstoxOrder;
// src/clients/upstoxClient.ts
const axios_1 = __importDefault(require("axios"));
const BASE = "https://api.upstox.com/v2";
// Helper to create client with specific token
const createUpstoxClient = (accessToken) => {
    return axios_1.default.create({
        baseURL: BASE,
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        timeout: 10000,
    });
};
exports.createUpstoxClient = createUpstoxClient;
// Legacy instance - uses env var if available, but doesn't crash if missing
const ENV_TOKEN = process.env.UPSTOX_TOKEN || "";
exports.upstoxApi = axios_1.default.create({
    baseURL: BASE,
    headers: {
        ...(ENV_TOKEN ? { "Authorization": `Bearer ${ENV_TOKEN}` } : {}),
        "Content-Type": "application/json"
    },
    timeout: 10000,
});
async function placeUpstoxOrder(payload, accessToken) {
    try {
        const token = accessToken || ENV_TOKEN;
        if (!token) {
            throw new Error("No Upstox Access Token provided (env UPSTOX_TOKEN missing and no dynamic token passed)");
        }
        const client = accessToken ? (0, exports.createUpstoxClient)(accessToken) : exports.upstoxApi;
        const resp = await client.post("/order/place", payload);
        return resp.data;
    }
    catch (err) {
        console.error("UPSTOX ORDER ERROR:", JSON.stringify(err.response?.data || err.message, null, 2));
        throw err;
    }
}
