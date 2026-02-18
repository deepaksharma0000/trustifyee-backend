// src/routes/auth.ts
import express from "express";
import AngelTokensModel from "../models/AngelTokens";
import { AngelOneAdapter, AngelSessionResp } from "../adapters/AngelOneAdapter";
import { log } from "../utils/logger";
import { encrypt, decrypt } from "../utils/encryption";
import { auth } from "../middleware/auth.middleware";
import User from "../models/User";
import Admin from "../models/Admin";
import { loginUser, loginAdmin } from "../controllers/AuthController";

const router = express.Router();
const adapter = new AngelOneAdapter();

// --------------------------------------------------------------------------
//  Unified App Login (Handles /api/auth/login from frontend)
// --------------------------------------------------------------------------
router.post("/login", async (req, res) => {
  const { email, user_name, clientcode, password } = req.body;
  const loginIdentifier = email || user_name || clientcode;

  if (!loginIdentifier) {
    return res.status(400).json({ error: "Email, User name or Client Code is required", status: false });
  }

  // 1. Try Admin Login (usually email based)
  const admin = await Admin.findOne({ email: loginIdentifier });
  if (admin) {
    req.body.email = loginIdentifier; // ensure loginAdmin gets it as email
    return loginAdmin(req, res);
  }

  // 2. Try User Login (could be email, user_name or client_key)
  const user = await User.findOne({
    $or: [
      { email: loginIdentifier },
      { user_name: loginIdentifier }
    ]
  });

  if (user) {
    req.body.user_name = user.user_name; // pass the actual user_name to loginUser controller
    return loginUser(req, res);
  }

  // Fallback to loginUser controller for standard error handling
  req.body.user_name = loginIdentifier;
  return loginUser(req, res);
});

router.get("/me", auth, async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(404).json({ error: "User not found" });

    // Mask keys if it's a regular user
    const userData = user.toObject ? user.toObject() : user;
    if (userData.client_key) userData.client_key = "********";
    if (userData.api_key) userData.api_key = "********";

    return res.json({ ok: true, user: userData });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------------------------
//  Angel One Login (Password + TOTP) - Trading APIs
// --------------------------------------------------------------------------
router.post("/angel/login", auth, async (req: any, res) => {
  try {
    const { clientcode, password, totp } = req.body;

    if (!clientcode || !password) {
      return res.status(400).json({ ok: false, error: "Client code and password required" });
    }

    // Call Angel One API
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

    const userId = req.id;

    // Save tokens
    await AngelTokensModel.findOneAndUpdate(
      { userId, clientcode },
      {
        userId,
        clientcode,
        jwtToken: encrypt(jwtToken),
        refreshToken: refreshToken ? encrypt(refreshToken) : undefined,
        feedToken: feedToken ? encrypt(feedToken) : undefined,
        expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1000)
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (req.user) {
      req.user.broker_connected = true;
      await req.user.save();
    }

    log.info(`Angel One session created for ${clientcode}`);

    return res.json({ ok: true, data: tokensData });
  } catch (err: any) {
    log.error("Angel login error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------------------------------------------------------
//  Logout / Session Management
// --------------------------------------------------------------------------

router.post("/logout", auth, async (req: any, res) => {
  const { clientcode } = req.body;
  const userId = req.id;
  if (!clientcode) return res.status(400).json({ error: "clientcode required" });

  try {
    await AngelTokensModel.deleteOne({ userId, clientcode }).exec();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || err });
  }
});

router.post("/validate-session", auth, async (req: any, res) => {
  const { clientcode } = req.body;
  const userId = req.id;
  if (!clientcode) return res.status(400).json({ ok: false, error: "clientcode required" });

  try {
    const tokenData = await AngelTokensModel.findOne({ userId, clientcode });
    if (!tokenData || !tokenData.jwtToken) {
      return res.json({ ok: false, error: "No session found" });
    }

    const profile = await adapter.getProfile(tokenData.jwtToken);

    if (profile && profile.status === true) {
      return res.json({ ok: true, data: profile.data });
    } else {
      // Try refresh
      if (tokenData.refreshToken) {
        log.info("Session invalid, trying refresh for", clientcode);
        try {
          const refreshResp = await adapter.generateTokensUsingRefresh(tokenData.refreshToken);
          if (refreshResp && refreshResp.status === true && refreshResp.data) {
            const newJwt = refreshResp.data.jwtToken || refreshResp.data.accessToken;
            const newFeed = refreshResp.data.feedToken || refreshResp.data.refreshToken;

            await AngelTokensModel.findOneAndUpdate(
              { userId, clientcode },
              {
                jwtToken: encrypt(newJwt),
                feedToken: newFeed ? encrypt(newFeed) : undefined
              },
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
