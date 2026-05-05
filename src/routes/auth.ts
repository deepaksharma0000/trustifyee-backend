// src/routes/auth.ts
import express from "express";
import { config } from '../config';
import AngelTokensModel from "../models/AngelTokens";
import AliceTokensModel from "../models/AliceTokens";
import UpstoxTokensModel from "../models/UpstoxTokens";
import { AngelOneAdapter, AngelSessionResp } from "../adapters/AngelOneAdapter";
import log from "../utils/logger";
import { encrypt, decrypt } from "../utils/encryption";
import { auth } from "../middleware/auth.middleware";
import User from "../models/User";
import Admin from "../models/Admin";
import mongoose from "mongoose";
import { loginUser, loginAdmin } from "../controllers/AuthController";

const router = express.Router();
// Removed global adapter to prevent startup crash. Adapters are now created lazily per request.

// --------------------------------------------------------------------------
//  Unified App Login (Handles /api/auth/login from frontend)
// --------------------------------------------------------------------------
router.post("/login", async (req, res) => {
  const { email, user_name, clientcode, password } = req.body;
  const loginIdentifier = email || user_name || clientcode;

  if (!loginIdentifier) {
    return res.status(400).json({ error: "Email, User name or Client Code is required", status: false });
  }

  // 1. Try Admin Login (handles email, mobile, or panel_client_key)
  const admin = await Admin.findOne({
    $or: [
      { email: loginIdentifier },
      { mobile: loginIdentifier },
      { panel_client_key: loginIdentifier },
      { client_key: loginIdentifier }
    ]
  });

  if (admin) {
    req.body.email = loginIdentifier; 
    return loginAdmin(req, res);
  }

  // 2. Try User Login (email, user_name or client_key)
  const user = await User.findOne({
    $or: [
      { email: loginIdentifier },
      { user_name: loginIdentifier },
      { client_key: loginIdentifier }
    ]
  });

  if (user) {
    req.body.user_name = user.user_name; 
    req.body.email = user.email;
    return loginUser(req, res);
  }

  // Fallback
  return loginUser(req, res);
});

router.get("/me", auth, async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(404).json({ error: "User not found" });

    // ✅ Convert to object and flatten Maps (for lot_multipliers)
    const userData = user.toObject ? user.toObject({ flattenMaps: true }) : user;
    
    // Mask sensitive keys but provide a hint that they exist
    if (userData.client_key) userData.client_code = "********"; // For UI pre-fill
    if (userData.broker_password) userData.broker_password = "********";
    if (userData.api_key) userData.api_key = "********";
    if (userData.broker_totp_secret) userData.broker_totp_secret = "********";

    return res.json({ ok: true, user: userData });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------------------------
//  Angel One Login (Password + TOTP) - Trading APIs
// --------------------------------------------------------------------------
router.post("/angel/login", auth, async (req: any, res) => {
  const userId = req.id;
  try {
    const { clientcode, password, totp } = req.body;

    if (!clientcode || !password) {
      return res.status(400).json({ ok: false, error: "Client code and password required" });
    }

    // 🚀 [LAZY ADAPTER]
    const user = await User.findById(userId) || await Admin.findById(userId);
    const apiKey = req.body.api_key || (user ? decrypt(user.api_key || "") : "");
    if (!apiKey) return res.status(400).json({ ok: false, error: "API Key missing. Please provide it." });

    const isValidIPv4 = (ip?: string): boolean => 
        !!ip && /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);

    const rawIp = (user as any)?.outgoing_ip || config.publicIp;
    const outgoingIp = isValidIPv4(rawIp) ? rawIp : config.publicIp;

    log.info(`[BROKER_AUTH] Final IP: ${outgoingIp} (raw was: ${rawIp})`);
    const adapter = new AngelOneAdapter(apiKey, outgoingIp);

    // Call Angel One API
    const resp: AngelSessionResp = await adapter.generateSession({ clientcode, password, totp });

    if (!resp || resp.status !== 200 || resp.data == null) {
      log.error(`[ANGEL_LOGIN] Failed for User ID: ${userId}, Client: ${clientcode}, Reason:`, resp?.message || "Unknown");
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

    log.info(`[ANGEL_LOGIN] ✅ Session successfully created for User ID: ${userId}, Client: ${clientcode}`);

    return res.json({ ok: true, data: tokensData });
  } catch (err: any) {
    log.error(`[ANGEL_LOGIN_EXCEPTION] Error for User ID ${userId}:`, err.message);
    if (err.response) {
      log.error(`[ANGEL_LOGIN_EXCEPTION] Broker HTTP Status: ${err.response.status} | Data: ${JSON.stringify(err.response.data)}`);
    }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------------------------------------------------------
//  Logout / Session Management
// --------------------------------------------------------------------------

router.post("/logout", auth, async (req: any, res) => {
  const userId = req.id;
  const userType = req.userType;

  try {
    log.info(`[AUTH] Disconnecting broker session for ${userType}: ${userId}`);

    // 1. Delete tokens from all possible broker models
    await Promise.allSettled([
      AngelTokensModel.deleteMany({ userId }).exec(),
      UpstoxTokensModel.deleteMany({ userId }).exec(),
      AliceTokensModel.deleteMany({ userId }).exec()
    ]);

    // 2. Update the User/Admin profile flags
    const ProfileModel = userType === 'admin' ? Admin : User;
    await ProfileModel.updateOne({ _id: userId }, {
      broker_connected: false,
      broker_verified: false,
      is_online: false
    });

    return res.json({ 
      status: true, 
      ok: true, 
      message: "Broker disconnected successfully and status synchronized." 
    });
  } catch (err: any) {
    log.error(`[AUTH] Logout error for ${userId}:`, err);
    return res.status(500).json({ status: false, error: err.message || "Logout failed" });
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

    const { createAngelAdapter } = await import('../utils/broker');
    const adapter = await createAngelAdapter(userId.toString());

    const profile = await adapter.getProfile(tokenData.jwtToken);

    if (profile && profile.status === 200) {
      return res.json({ ok: true, data: profile.data });
    } else {
      // Try refresh
      if (tokenData.refreshToken) {
        log.info("Session invalid, trying refresh for", clientcode);
        try {
          const refreshResp = await adapter.generateTokensUsingRefresh(tokenData.refreshToken);
          if (refreshResp && refreshResp.status === 200 && refreshResp.data) {
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
