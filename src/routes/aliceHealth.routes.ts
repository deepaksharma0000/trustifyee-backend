import express from "express";
import { AliceInstrumentSyncService } from "../services/AliceInstrumentSyncService";
import { AliceBlueBroadcastValidationService } from "../services/AliceBlueBroadcastValidationService";
import { Signal } from "../models/Signal";
import { auth, adminOnly } from "../middleware/auth.middleware";
import log from "../utils/logger";

const router = express.Router();

/**
 * GET /api/alice/health/instruments
 * Last sync time, instrument count, sync status.
 */
router.get("/health/instruments", async (_req, res) => {
  try {
    const health = await AliceInstrumentSyncService.getHealthSnapshot();
    res.json({ ok: true, data: health });
  } catch (err: any) {
    log.error("[AliceHealth] instruments health failed", err?.message);
    res.status(500).json({ ok: false, error: err?.message || "Health check failed" });
  }
});

/**
 * POST /api/alice/validation/broadcast
 * Preview Alice Blue user eligibility before admin broadcast.
 * body: { signalId?: string, strategy?: string, exchange?, tradingsymbol?, symboltoken? }
 */
router.post("/validation/broadcast", auth, adminOnly, async (req, res) => {
  try {
    const { signalId, strategy, exchange, tradingsymbol, symboltoken } = req.body || {};

    let signalPayload: {
      _id?: string;
      exchange?: string;
      tradingsymbol?: string;
      symboltoken?: string;
    } = { exchange, tradingsymbol, symboltoken };

    if (signalId) {
      const signal = await Signal.findById(signalId).lean();
      if (!signal) {
        return res.status(404).json({ ok: false, error: "Signal not found" });
      }
      signalPayload = {
        _id: String(signal._id),
        exchange: signal.exchange,
        tradingsymbol: signal.tradingsymbol,
        symboltoken: signal.symboltoken,
      };
    }

    if (!signalPayload.tradingsymbol && !signalId) {
      const targetStrategy = String(strategy || "Manual");
      const report = await AliceBlueBroadcastValidationService.previewForStrategy(
        targetStrategy,
        signalPayload
      );
      return res.json({ ok: true, data: report });
    }

    const targetStrategy = String(strategy || "Manual");
    const previewUsers = await AliceBlueBroadcastValidationService.previewForStrategy(
      targetStrategy,
      signalPayload
    );

    return res.json({ ok: true, data: previewUsers });
  } catch (err: any) {
    log.error("[AliceValidation] broadcast preview failed", err?.message);
    res.status(500).json({ ok: false, error: err?.message || "Validation failed" });
  }
});

export default router;
