"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
router.post("/order/place", auth_middleware_1.auth, auth_middleware_1.adminOnly, async (req, res) => {
    try {
        const { userId, instrument_key, lots, side, type, price } = req.body;
        if (!userId) {
            // Optional: For backward compatibility, if no userId, we might try to rely on env token?
            // But user specifically wants to avoid env token.
            // So we should enforce userId if we want to be "production friendly" for multiple users.
            // However, if the user hasn't updated their frontend, this might break.
            // Let's make it required to fix the "hardcoded token" issue properly.
            return res.status(400).json({ error: "userId is required to identify Upstox session" });
        }
        if (!instrument_key)
            return res.status(400).json({ error: "instrument_key is required" });
        const accessToken = await getAccessToken(userId);
        const response = await (0, orderServices_1.placeOptionOrder)(instrument_key, Number(lots), side, type, price ? Number(price) : 0, accessToken);
        res.json(response);
    }
    catch (error) {
        console.error("ORDER ROUTE ERROR:", error);
        res.status(400).json({ error: error.message });
    }
});
exports.default = router;
