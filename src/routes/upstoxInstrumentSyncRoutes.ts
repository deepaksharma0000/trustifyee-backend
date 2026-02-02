// src/routes/upstoxInstrumentSyncRoutes.ts
import { Router } from "express";
import { syncNseFoInstruments } from "../services/upstoxInstrumentSyncService";

const router = Router();

// Manual trigger: GET /api/upstox/instruments/sync/nse-fo
router.get("/sync/nse-fo", async (req, res) => {
  try {
    await syncNseFoInstruments();
    res.json({ ok: true, message: "NSE_FO instruments synced" });
  } catch (err: any) {
    console.error("NSE_FO sync error", err);
    res.status(500).json({ ok: false, error: err.message || err });
  }
});

export default router;
