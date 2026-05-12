// src/routes/aliceAuth.ts
import express from "express";
import AliceTokensModel from "../models/AliceTokens";
import log from "../utils/logger";
import { AliceBlueAdapter } from "../adapters/AliceBlueAdapter";
import { encrypt } from "../utils/encryption";
import { config } from "../config";
import { auth } from "../middleware/auth.middleware";
import { findUserByClientCode } from "../utils/clientCodeLookup";

const router = express.Router();
const aliceAdapter = new AliceBlueAdapter();

/**
 * GET /api/alice/auth/login-url?clientcode=LALIT_ALICE
 * -> returns { url: "https://ant.aliceblueonline.com/?appcode=..." }
 */
router.get("/auth/login-url", auth, async (req: any, res) => {
  try {
    const clientcode = String(req.query.clientcode || "").trim();
    if (!clientcode) {
      return res.status(400).json({ error: "clientcode is required" });
    }

    // Pass User ID in state so we can find them reliably in callback
    const state = `${req.id}:${clientcode}`;
    const url = aliceAdapter.getLoginUrl(state);
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
  const aliceUserId = String(req.query.userId || ""); // Alice Blue Client ID
  const rawState = String(req.query.state || ""); // "mongoUserId:clientcode"

  let mongoUserId = "";
  let clientcode = "";

  if (rawState.includes(":")) {
    [mongoUserId, clientcode] = rawState.split(":");
  } else {
    clientcode = rawState || "DEFAULT_CLIENT";
  }

  if (!authCode || !aliceUserId) {
    return res.status(400).send("Missing authCode or Alice userId");
  }

  try {
    // Pass aliceUserId directly to generate correct checksum
    const data = await aliceAdapter.getSessionFromAuthCode(authCode, aliceUserId);

    if (data.stat !== "Ok" || !data.userSession) {
      log.error(`[ALICE_AUTH] login failed for Client: ${clientcode}, Reason: ${data.emsg || "Unknown error"}`);
      return res
        .status(400)
        .send(`Alice login failed: ${data.emsg || "Unknown error"}`);
    }

    const saved = await AliceTokensModel.findOneAndUpdate(
      { clientcode },
      {
        userId: mongoUserId ? (mongoUserId as any) : undefined,
        clientcode,
        // 🚀 Alice Blue Open API requires "Bearer <UserId> <UserSession>"
        // Concatenate them before encrypting for the adapter to use
        sessionId: encrypt(`${data.userId || aliceUserId} ${data.userSession}`),
        expiresAt: undefined
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    // 🚀 [USER MODEL SYNC] - Reliable update using User ID
    const User = require("../models/User").default;
    
    if (mongoUserId) {
      await User.updateOne(
        { _id: mongoUserId },
        { 
          broker: "AliceBlue",
          broker_connected: true,
          broker_verified: true,
          is_online: true
        }
      );
    } else {
      // Fallback (Legacy/Incomplete State)
      const matchedUser = await findUserByClientCode(clientcode);
      if (matchedUser?._id) {
        await User.updateOne(
          { _id: matchedUser._id },
          {
            broker: "AliceBlue",
            broker_connected: true,
            broker_verified: true,
            is_online: true,
            trading_paused: false, // [FIX] Reset circuit breaker
            consecutive_failures: 0 // [FIX] Reset failure count
          }
        );
      }
    }

    log.info(`[ALICE_AUTH] ✅ Saved Alice session and updated User profile for: ${clientcode}`);

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
