// src/routes/auth.ts
import express from "express";
import AngelTokensModel from "../models/AngelTokens";
import { AngelOneAdapter, AngelSessionResp } from "../adapters/AngelOneAdapter";
import { log } from "../utils/logger";


const router = express.Router();
const adapter = new AngelOneAdapter();


router.post("/login", async (req, res) => {
  const { clientcode, password, totp } = req.body;
  if (!clientcode || !password) {
    return res.status(400).json({ error: "clientcode and password required" });
  }

  try {
    const resp: AngelSessionResp = await adapter.generateSession({ clientcode, password, totp });

    if (!resp || resp.status === false || resp.data == null) {
      log.error("Angel login failed:", resp);
      return res.status(401).json({
        ok: false,
        error: resp?.message || "Angel login failed",
        code: (resp as any)?.errorcode
      });
    }

    const tokensData = resp.data;

    const jwtToken = tokensData.jwtToken || tokensData.accessToken || tokensData.token;
    const refreshToken = tokensData.refreshToken;
    const feedToken = tokensData.websocketToken || tokensData.feedToken;

    if (!jwtToken) {
      log.error("No jwtToken found in Angel response:", resp);
      return res.status(500).json({ ok: false, error: "Missing jwtToken in Angel response" });
    }


    const saved = await AngelTokensModel.findOneAndUpdate(
      { clientcode },
      { clientcode, jwtToken, refreshToken, feedToken, expiresAt: undefined },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    log.debug("Saved Angel session for client:", clientcode, saved);

    return res.json({ ok: true, data: tokensData });
  } catch (err: any) {
    log.error("login error", err.message || err);
    return res.status(500).json({ error: err.message || err });
  }
});



router.post("/logout", async (req, res) => {
  const { clientcode } = req.body;
  if (!clientcode) return res.status(400).json({ error: "clientcode required" });

  try {
    await AngelTokensModel.deleteOne({ clientcode }).exec();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || err });
  }
});

router.post("/validate-session", async (req, res) => {
  const { clientcode } = req.body;
  if (!clientcode) return res.status(400).json({ ok: false, error: "clientcode required" });

  try {
    const tokenData = await AngelTokensModel.findOne({ clientcode });
    if (!tokenData || !tokenData.jwtToken) {
      return res.json({ ok: false, error: "No session found" });
    }

    const profile = await adapter.getProfile(tokenData.jwtToken);

    // AngelOne successful response usually has status: true or data
    if (profile && profile.status === true) {
      return res.json({ ok: true, data: profile.data });
    } else {
      // Check if we can refresh
      if (tokenData.refreshToken) {
        log.info("Session invalid, trying refresh for", clientcode);
        try {
          const refreshResp = await adapter.generateTokensUsingRefresh(tokenData.refreshToken);
          if (refreshResp && refreshResp.status === true && refreshResp.data) {
            const newJwt = refreshResp.data.jwtToken || refreshResp.data.accessToken;
            const newFeed = refreshResp.data.feedToken || refreshResp.data.refreshToken;

            await AngelTokensModel.findOneAndUpdate(
              { clientcode },
              { jwtToken: newJwt, feedToken: newFeed },
              { new: true }
            );
            return res.json({ ok: true, refreshed: true });
          }
        } catch (e) {
          log.error("Refresh failed for", clientcode);
        }
      }
      return res.json({ ok: false, error: "Session expired or invalid" });
    }
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;




