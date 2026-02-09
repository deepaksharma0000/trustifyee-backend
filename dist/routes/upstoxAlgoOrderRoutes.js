"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/upstoxAlgoOrderRoutes.ts
const express_1 = require("express");
const orderServices_1 = require("../services/orderServices");
const UpstoxTokens_1 = __importDefault(require("../models/UpstoxTokens"));
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = (0, express_1.Router)();
async function getAccessToken(userId) {
    const doc = await UpstoxTokens_1.default.findOne({ userId }).exec();
    if (!doc || !doc.accessToken)
        throw new Error("No active Upstox session for userId");
    return doc.accessToken;
}
/**
 * POST /api/upstox/option/algo-order
 * Body:
 * {
 *   "userId": "admin",
 *   "underlyingSymbol": "NIFTY",
 *   "ltp": 24210,
 *   "side": "BUY",
 *   "optionSide": "CE",
 *   "type": "MARKET",
 *   "lots": 1,
 *   "strikesAway": 0,
 *   "expiryMode": "NEAREST"
 * }
 */
router.post("/option/algo-order", auth_middleware_1.auth, auth_middleware_1.adminOnly, async (req, res) => {
    try {
        const { userId, underlyingSymbol, ltp, side, optionSide, type, lots, strikesAway, expiryMode, price, } = req.body;
        if (!userId) {
            return res.status(400).json({ error: "userId is required to identify Upstox session" });
        }
        const accessToken = await getAccessToken(userId);
        if (!underlyingSymbol || typeof underlyingSymbol !== "string") {
            return res
                .status(400)
                .json({ error: "underlyingSymbol is required (e.g. NIFTY)" });
        }
        if (!ltp || typeof ltp !== "number") {
            return res
                .status(400)
                .json({ error: "ltp (underlying price) is required as number" });
        }
        const resp = await (0, orderServices_1.placeAlgoOptionOrder)({
            underlyingSymbol: underlyingSymbol.trim().toUpperCase(),
            ltp,
            side,
            optionSide,
            type,
            lots: Number(lots),
            strikesAway: strikesAway ? Number(strikesAway) : 0,
            expiryMode: expiryMode || "NEAREST",
            price: price ? Number(price) : undefined,
            accessToken,
        });
        res.json(resp);
    }
    catch (err) {
        console.error("ALGO ORDER ERROR:", err);
        res.status(400).json({ error: err.message || err });
    }
});
exports.default = router;
