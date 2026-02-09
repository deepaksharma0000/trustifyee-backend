"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchAndStoreOptionChain = fetchAndStoreOptionChain;
// src/services/optionService.ts
const upstoxClient_1 = require("../clients/upstoxClient");
const optionRepo_1 = require("../repositories/optionRepo");
async function fetchAndStoreOptionChain(underlying = "NSE_INDEX|Nifty 50", accessToken) {
    const client = accessToken ? (0, upstoxClient_1.createUpstoxClient)(accessToken) : upstoxClient_1.upstoxApi;
    // If using default client and no env token, this might fail with 401, which is expected if not configured.
    const resp = await client.get(`/option/contract?instrument_key=${encodeURIComponent(underlying)}`);
    if (resp.data.status !== "success") {
        throw new Error("Upstox returned non-success status");
    }
    const list = resp.data.data;
    await (0, optionRepo_1.upsertOptions)(list);
    return {
        count: list.length,
        message: "Options updated successfully",
    };
}
