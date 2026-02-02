// src/routes/aliceAuth.ts
import express from "express";
import AliceTokensModel from "../models/AliceTokens";
import { log } from "../utils/logger";
import { AliceBlueAdapter } from "../adapters/AliceBlueAdapter";

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
      log.error("Alice getUserDetails failed:", data);
      return res
        .status(400)
        .send(`Alice login failed: ${data.emsg || "Unknown error"}`);
    }

    const saved = await AliceTokensModel.findOneAndUpdate(
      { clientcode },
      {
        clientcode,
        sessionId: data.userSession,
        // optional: agar model extend kara ho
        // aliceUserId: userId,
        // aliceClientId: data.clientId,
        expiresAt: undefined
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    log.debug("Saved Alice session for client:", clientcode, saved);

    // Simple response: dev phase me ye theek hai
    return res.send("Alice Blue account connected successfully. You can close this tab.");
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
        sessionId,
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
