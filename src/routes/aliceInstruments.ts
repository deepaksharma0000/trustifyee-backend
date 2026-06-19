import express from "express";
import { AliceInstrumentService } from "../services/aliceInstrumentService";
import { AliceInstrumentSyncService } from "../services/AliceInstrumentSyncService";
import { auth, adminOnly } from "../middleware/auth.middleware";
import log from "../utils/logger";

const router = express.Router();

/**
 * POST /api/alice/ins/instruments/sync
 * body: { "exchange": "NFO", "clientcode": "optional" }
 */
router.post("/instruments/sync", auth, adminOnly, async (req, res) => {
  const { exchange } = req.body;
  const ex = String(exchange || "NFO").toUpperCase();

  try {
    if (ex === "NFO") {
      const result = await AliceInstrumentSyncService.syncNfo({
        triggeredBy: "manual",
        force: req.body?.force === true,
      });
      return res.json({ ok: true, sync: result });
    }

    const result = await AliceInstrumentService.syncExchangeInstruments({
      clientcode: req.body?.clientcode ? String(req.body.clientcode) : undefined,
      exchange: ex,
    });
    return res.json({ ok: true, ...result });
  } catch (err: any) {
    log.error("Alice /instruments/sync error:", err?.message || err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

export default router;
