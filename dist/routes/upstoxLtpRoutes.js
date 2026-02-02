"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const UpstoxAdapter_1 = require("../adapters/UpstoxAdapter");
const UpstoxTokens_1 = __importDefault(require("../models/UpstoxTokens"));
const router = (0, express_1.Router)();
const adapter = new UpstoxAdapter_1.UpstoxAdapter();
async function getAccessToken(userId) {
    const doc = await UpstoxTokens_1.default.findOne({ userId }).exec();
    if (!doc || !doc.accessToken) {
        throw new Error("No active Upstox session for userId");
    }
    return doc.accessToken;
}
// GET /api/upstox/index-ltp?userId=ABC123&symbol=NIFTY
router.get("/index-ltp", async (req, res) => {
    try {
        const { userId, symbol } = req.query;
        if (!userId) {
            return res.status(400).json({ error: "userId is required" });
        }
        if (!symbol) {
            return res.status(400).json({ error: "symbol is required (NIFTY/BANKNIFTY)" });
        }
        const map = {
            NIFTY: "NSE_INDEX|Nifty 50",
            BANKNIFTY: "NSE_INDEX|Nifty Bank",
        };
        const key = map[String(symbol).toUpperCase()];
        if (!key) {
            return res.status(400).json({ error: "Unsupported symbol. Use NIFTY or BANKNIFTY" });
        }
        const accessToken = await getAccessToken(String(userId));
        const apiResp = await adapter.getLtp(accessToken, key);
        const data = apiResp?.data || {};
        let entry = data[key];
        if (!entry) {
            const altKey = key.replace("|", ":");
            entry = data[altKey];
        }
        // 3) last fallback: jo bhi pehla value ho
        if (!entry) {
            const firstVal = Object.values(data)[0];
            if (firstVal && typeof firstVal === "object") {
                entry = firstVal;
            }
        }
        const ltp = entry?.last_price;
        if (ltp === undefined) {
            return res.status(500).json({
                error: "LTP not found in Upstox response",
                raw: apiResp,
            });
        }
        // const ltp = apiResp?.data?.[key]?.last_price;
        // if (ltp === undefined) {
        //   return res.status(500).json({
        //     error: "LTP not found in Upstox response",
        //     raw: apiResp,
        //   });
        // }
        return res.json({
            ok: true,
            symbol,
            //   instrument_key: key,
            instrument_key: entry.instrument_token || key,
            ltp,
        });
    }
    catch (err) {
        console.error("index-ltp error", err);
        return res.status(500).json({ ok: false, error: err.message || err });
    }
});
exports.default = router;
