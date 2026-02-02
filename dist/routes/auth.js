"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/auth.ts
const express_1 = __importDefault(require("express"));
const AngelTokens_1 = __importDefault(require("../models/AngelTokens"));
const AngelOneAdapter_1 = require("../adapters/AngelOneAdapter");
const logger_1 = require("../utils/logger");
const router = express_1.default.Router();
const adapter = new AngelOneAdapter_1.AngelOneAdapter();
router.post("/login", async (req, res) => {
    const { clientcode, password, totp } = req.body;
    if (!clientcode || !password) {
        return res.status(400).json({ error: "clientcode and password required" });
    }
    try {
        const resp = await adapter.generateSession({ clientcode, password, totp });
        if (!resp || resp.status === false || resp.data == null) {
            logger_1.log.error("Angel login failed:", resp);
            return res.status(401).json({
                ok: false,
                error: resp?.message || "Angel login failed",
                code: resp?.errorcode
            });
        }
        const tokensData = resp.data;
        const jwtToken = tokensData.jwtToken || tokensData.accessToken || tokensData.token;
        const refreshToken = tokensData.refreshToken;
        const feedToken = tokensData.websocketToken || tokensData.feedToken;
        if (!jwtToken) {
            logger_1.log.error("No jwtToken found in Angel response:", resp);
            return res.status(500).json({ ok: false, error: "Missing jwtToken in Angel response" });
        }
        const saved = await AngelTokens_1.default.findOneAndUpdate({ clientcode }, { clientcode, jwtToken, refreshToken, feedToken, expiresAt: undefined }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
        logger_1.log.debug("Saved Angel session for client:", clientcode, saved);
        return res.json({ ok: true, data: tokensData });
    }
    catch (err) {
        logger_1.log.error("login error", err.message || err);
        return res.status(500).json({ error: err.message || err });
    }
});
router.post("/logout", async (req, res) => {
    const { clientcode } = req.body;
    if (!clientcode)
        return res.status(400).json({ error: "clientcode required" });
    try {
        await AngelTokens_1.default.deleteOne({ clientcode }).exec();
        return res.json({ ok: true });
    }
    catch (err) {
        return res.status(500).json({ error: err.message || err });
    }
});
exports.default = router;
