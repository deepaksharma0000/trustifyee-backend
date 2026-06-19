import express from "express";
import { auth, adminAuth } from "../middleware/auth.middleware";
import {
  connectZerodha,
  zerodhaCallback,
  getZerodhaAuthUrl,
  refreshZerodhaSession,
  disconnectZerodha,
  getZerodhaProfile,
  getZerodhaStatus,
  getZerodhaOrders,
  getZerodhaPositions,
  getZerodhaHoldings,
  getZerodhaFunds,
  getAdminZerodhaStatus,
} from "../controllers/ZerodhaController";

const router = express.Router();

/** POST /api/zerodha/connect — initiate Kite Connect OAuth */
router.post("/connect", auth, connectZerodha);

/** GET /api/zerodha/callback — Kite OAuth redirect handler */
router.get("/callback", zerodhaCallback);

/** Legacy alias */
router.get("/auth/callback", zerodhaCallback);

/** GET /api/zerodha/auth/url — legacy auth URL endpoint */
router.get("/auth/url", auth, getZerodhaAuthUrl);

/** POST /api/zerodha/refresh — validate / refresh session */
router.post("/refresh", auth, refreshZerodhaSession);

/** POST /api/zerodha/disconnect — logout and clear credentials */
router.post("/disconnect", auth, disconnectZerodha);

/** GET /api/zerodha/profile */
router.get("/profile", auth, getZerodhaProfile);

/** GET /api/zerodha/status — broker connection status */
router.get("/status", auth, getZerodhaStatus);

/** GET /api/zerodha/orders */
router.get("/orders", auth, getZerodhaOrders);

/** GET /api/zerodha/positions */
router.get("/positions", auth, getZerodhaPositions);

/** GET /api/zerodha/holdings */
router.get("/holdings", auth, getZerodhaHoldings);

/** GET /api/zerodha/funds */
router.get("/funds", auth, getZerodhaFunds);

/** Admin: GET /api/zerodha/admin/status/:id */
router.get("/admin/status/:id", adminAuth, getAdminZerodhaStatus);

export default router;
