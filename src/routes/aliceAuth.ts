// src/routes/aliceAuth.ts
import express from "express";
import AliceTokensModel from "../models/AliceTokens";
import { log } from "../utils/logger";
import { AliceBlueAdapter } from "../adapters/AliceBlueAdapter";
import { encrypt } from "../utils/encryption";
import { config } from "../config";

const router = express.Router();
const aliceAdapter = new AliceBlueAdapter();

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
  } catch (err: any) {
    log.error("Alice /auth/login-url error", err.message || err);
    return res.status(500).json({ error: err.message || err });
  }
});

/**
 * ⚠️ IMPORTANT: The Redirect URL MUST be configured on the Alice Blue Developer Portal.
 * On production, it should be: https://trustifye.cloud/api/alice/auth/callback
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
      log.error("Alice getUserDetails failed:", data);
      return res
        .status(400)
        .send(`Alice login failed: ${data.emsg || "Unknown error"}`);
    }

    const saved = await AliceTokensModel.findOneAndUpdate(
      { clientcode },
      {
        clientcode,
        sessionId: encrypt(data.userSession),
        expiresAt: undefined
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    // 🚀 [USER MODEL SYNC]
    // Update the User document so the system knows they are using AliceBlue
    const User = require("../models/User").default;
    const { encrypt: dbEncrypt } = require("../utils/encryption");
    
    // We search for the user with this encrypted client_key
    const encryptedCC = dbEncrypt(clientcode);
    await User.findOneAndUpdate(
      { client_key: encryptedCC },
      { 
        broker: "AliceBlue",
        broker_connected: true,
        broker_verified: true,
        is_online: true
      }
    );

    log.debug("Saved Alice session and updated User profile for:", clientcode);

    // Redirect back to frontend dashboard
    return res.redirect(`${config.frontendUrl}/dashboard?broker_login=success&broker=AliceBlue`);
  } catch (err: any) {
    log.error("Alice /auth/callback error", err.message || err);
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
    const saved = await AliceTokensModel.findOneAndUpdate(
      { clientcode },
      {
        clientcode,
        sessionId: encrypt(sessionId),
        expiresAt: undefined
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    log.debug("Saved Alice session for client (manual):", clientcode, saved);

    return res.json({ ok: true, data: { sessionId } });
  } catch (err: any) {
    log.error("Alice /login error", err.message || err);
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
    await AliceTokensModel.deleteOne({ clientcode }).exec();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || err });
  }
});

export default router;
