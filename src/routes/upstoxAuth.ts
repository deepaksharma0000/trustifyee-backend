// src/routes/upstoxAuth.ts
import express from "express";
import { UpstoxAdapter } from "../adapters/UpstoxAdapter";
import UpstoxTokensModel from "../models/UpstoxTokens";
import { log } from "../utils/logger";

const router = express.Router();
const adapter = new UpstoxAdapter();

/**
 * GET /api/upstox/auth/url
 * Returns login URL for user to open in browser
 */
router.get("/url", (req, res) => {
  const state = req.query.state?.toString() || "state-" + Date.now();
  const url = adapter.getAuthUrl(state);
  
  log.debug("Generated Upstox auth URL for state:", state);
  
  return res.json({ 
    ok: true,
    url, 
    state 
  });
});

/**
 * GET /api/upstox/auth/callback?code=...&state=...
 * Upstox redirects here after user login
 */
router.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  log.debug("Upstox callback received:", { code: code ? "present" : "missing", state });

  if (!code || typeof code !== "string") {
    return res.status(400).json({ 
      ok: false, 
      error: "Missing authorization code" 
    });
  }

  try {
    const tokenResp = await adapter.exchangeCodeForToken(code);

    // Calculate token expiry (usually 1 day for Upstox)
    const expiresAt = new Date(Date.now() + (24 * 60 * 60 * 1000));

    const doc = await UpstoxTokensModel.findOneAndUpdate(
      { userId: tokenResp.user_id },
      {
        userId: tokenResp.user_id,
        accessToken: tokenResp.access_token,
        extendedToken: tokenResp.extended_token,
        refreshToken: tokenResp.refresh_token,
        email: tokenResp.email,
        userName: tokenResp.user_name,
        exchanges: tokenResp.exchanges,
        products: tokenResp.products,
        orderTypes: tokenResp.order_types,
        expiresAt: expiresAt
      },
      { upsert: true, new: true }
    );

    log.info("Upstox login successful for user:", tokenResp.user_id);

    // You can redirect to your frontend or return JSON
    return res.json({
      ok: true,
      message: "Login successful",
      user: {
        userId: tokenResp.user_id,
        email: tokenResp.email,
        userName: tokenResp.user_name,
        exchanges: tokenResp.exchanges,
        accessTokenLast4: tokenResp.access_token
      }
    });

  } catch (err: any) {
    log.error("Upstox callback error:", err.message || err);
    return res.status(500).json({ 
      ok: false, 
      error: err.message || "Authentication failed" 
    });
  }
});

/**
 * POST /api/upstox/auth/refresh
 * Refresh access token using refresh token
 */
router.post("/refresh", async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ 
      ok: false, 
      error: "userId is required" 
    });
  }

  try {
    // Get existing token from database
    const existingToken = await UpstoxTokensModel.findOne({ userId });
    
    if (!existingToken || !existingToken.refreshToken) {
      return res.status(404).json({ 
        ok: false, 
        error: "User not found or no refresh token available" 
      });
    }

    // Refresh the token
    const tokenResp = await adapter.refreshAccessToken(existingToken.refreshToken);
    
    // Update in database
    const expiresAt = new Date(Date.now() + (24 * 60 * 60 * 1000));
    
    const updated = await UpstoxTokensModel.findOneAndUpdate(
      { userId },
      {
        accessToken: tokenResp.access_token,
        extendedToken: tokenResp.extended_token,
        refreshToken: tokenResp.refresh_token,
        expiresAt: expiresAt
      },
      { new: true }
    );

    log.info("Token refreshed for user:", userId);

    return res.json({
      ok: true,
      message: "Token refreshed successfully",
      accessTokenLast4: tokenResp.access_token.slice(-4)
    });

  } catch (err: any) {
    log.error("Token refresh error:", err.message || err);
    return res.status(500).json({ 
      ok: false, 
      error: err.message || "Token refresh failed" 
    });
  }
});

/**
 * GET /api/upstox/auth/profile
 * Get user profile using stored access token
 */
router.get("/profile", async (req, res) => {
  const { userId } = req.query;

  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ 
      ok: false, 
      error: "userId query parameter is required" 
    });
  }

  try {
    const tokenDoc = await UpstoxTokensModel.findOne({ userId });
    
    if (!tokenDoc) {
      return res.status(404).json({ 
        ok: false, 
        error: "User not found" 
      });
    }

    const profile = await adapter.getUserProfile(tokenDoc.accessToken);

    return res.json({
      ok: true,
      profile: profile.data
    });

  } catch (err: any) {
    log.error("Get profile error:", err.message || err);
    return res.status(500).json({ 
      ok: false, 
      error: err.message || "Failed to get profile" 
    });
  }
});

/**
 * GET /api/upstox/auth/status
 * Check if user is logged in and token is valid
 */
router.get("/status", async (req, res) => {
  const { userId } = req.query;

  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ 
      ok: false, 
      error: "userId query parameter is required" 
    });
  }

  try {
    const tokenDoc = await UpstoxTokensModel.findOne({ userId });
    
    if (!tokenDoc) {
      return res.json({ 
        ok: true, 
        isLoggedIn: false,
        message: "User not found" 
      });
    }

    // Validate token
    const validation = await adapter.validateToken(tokenDoc.accessToken);

    return res.json({
      ok: true,
      isLoggedIn: validation.isValid,
      user: {
        userId: tokenDoc.userId,
        email: tokenDoc.email,
        userName: tokenDoc.userName,
        isValid: validation.isValid
      },
      expiresAt: tokenDoc.expiresAt
    });

  } catch (err: any) {
    log.error("Status check error:", err.message || err);
    return res.status(500).json({ 
      ok: false, 
      error: err.message || "Status check failed" 
    });
  }
});

/**
 * POST /api/upstox/auth/logout
 * Remove user tokens from database
 */
router.post("/logout", async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ 
      ok: false, 
      error: "userId is required" 
    });
  }

  try {
    await UpstoxTokensModel.deleteOne({ userId });
    
    log.info("User logged out:", userId);
    
    return res.json({ 
      ok: true, 
      message: "Logged out successfully" 
    });

  } catch (err: any) {
    log.error("Logout error:", err.message || err);
    return res.status(500).json({ 
      ok: false, 
      error: err.message || "Logout failed" 
    });
  }
});


export default router;