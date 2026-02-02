"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/aliceAuth.ts
const express_1 = __importDefault(require("express"));
const AliceTokens_1 = __importDefault(require("../models/AliceTokens"));
const logger_1 = require("../utils/logger");
const AliceBlueAdapter_1 = require("../adapters/AliceBlueAdapter");
const router = express_1.default.Router();
const aliceAdapter = new AliceBlueAdapter_1.AliceBlueAdapter();
/**
 * GET /api/alice/auth/login-url?clientcode=LALIT_ALICE
 * -> returns { url: "https://ant.aliceblueonline.com/?appcode=..." }
 */
router.get("/auth/login-url", async (req, res) => {
    try {
        const clientcode = String(req.query.clientcode || "").trim();
        if (!clientcode) {
            return res.status(400).json({ error: "clientcode is required" });
        }
        const url = aliceAdapter.getLoginUrl(clientcode);
        return res.json({ url });
    }
    catch (err) {
        logger_1.log.error("Alice /auth/login-url error", err.message || err);
        return res.status(500).json({ error: err.message || err });
    }
});
/**
 * Redirect URL configured on Alice:
 * http://localhost:3000/api/alice/auth/callback
 *
 * Alice will redirect with:
 *  ?authCode=xxxx&userId=123456&state=CLIENTCODE
 */
router.get("/auth/callback", async (req, res) => {
    const authCode = String(req.query.authCode || "");
    const userId = String(req.query.userId || "");
    const clientcode = String(req.query.state || "DEFAULT_CLIENT");
    if (!authCode || !userId) {
        return res.status(400).send("Missing authCode or userId");
    }
    try {
        const data = await aliceAdapter.getSessionFromAuthCode(authCode, userId);
        if (data.stat !== "Ok" || !data.userSession) {
            logger_1.log.error("Alice getUserDetails failed:", data);
            return res
                .status(400)
                .send(`Alice login failed: ${data.emsg || "Unknown error"}`);
        }
        const saved = await AliceTokens_1.default.findOneAndUpdate({ clientcode }, {
            clientcode,
            sessionId: data.userSession,
            // optional: agar model extend kara ho
            // aliceUserId: userId,
            // aliceClientId: data.clientId,
            expiresAt: undefined
        }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
        logger_1.log.debug("Saved Alice session for client:", clientcode, saved);
        // Simple response: dev phase me ye theek hai
        return res.send("Alice Blue account connected successfully. You can close this tab.");
    }
    catch (err) {
        logger_1.log.error("Alice /auth/callback error", err.message || err);
        return res.status(500).send(err.message || "Internal error");
    }
});
/**
 * OLD manual /login route
 * Agar chaho to dev ke liye rakho bhi sakte ho
 */
router.post("/login", async (req, res) => {
    const { clientcode, sessionId } = req.body;
    if (!clientcode || !sessionId) {
        return res
            .status(400)
            .json({ error: "clientcode and sessionId required" });
    }
    try {
        const saved = await AliceTokens_1.default.findOneAndUpdate({ clientcode }, {
            clientcode,
            sessionId,
            expiresAt: undefined
        }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
        logger_1.log.debug("Saved Alice session for client (manual):", clientcode, saved);
        return res.json({ ok: true, data: { sessionId } });
    }
    catch (err) {
        logger_1.log.error("Alice /login error", err.message || err);
        return res.status(500).json({ error: err.message || err });
    }
});
/**
 * LOGOUT same as before
 */
router.post("/logout", async (req, res) => {
    const { clientcode } = req.body;
    if (!clientcode)
        return res.status(400).json({ error: "clientcode required" });
    try {
        await AliceTokens_1.default.deleteOne({ clientcode }).exec();
        return res.json({ ok: true });
    }
    catch (err) {
        return res.status(500).json({ error: err.message || err });
    }
});
exports.default = router;
