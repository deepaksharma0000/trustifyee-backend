"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.upstoxApi = void 0;
exports.placeUpstoxOrder = placeUpstoxOrder;
// src/clients/upstoxClient.ts
const axios_1 = __importDefault(require("axios"));
const BASE = "https://api.upstox.com/v2";
const TOKEN = process.env.UPSTOX_TOKEN;
exports.upstoxApi = axios_1.default.create({
    baseURL: BASE,
    headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
    },
    timeout: 10000,
});
async function placeUpstoxOrder(payload) {
    try {
        const resp = await exports.upstoxApi.post("/order/place", payload);
        return resp.data;
    }
    catch (err) {
        // console.error("UPSTOX ORDER ERROR:", err.response?.data || err);
        console.error("UPSTOX ORDER ERROR:", JSON.stringify(err.response?.data, null, 2));
        throw err;
    }
}
