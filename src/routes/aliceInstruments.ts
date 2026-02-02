import express from "express";
import { AliceInstrumentService } from "../services/aliceInstrumentService";

const router = express.Router();

/**
 * POST /api/alice/instruments/sync
 * body:
 * {
 *   "clientcode": "LALIT_ALICE",
 *   "exchange": "NFO"       // ya "NSE"
 * }
 */
router.post("/instruments/sync", async (req, res) => {
  const { clientcode, exchange } = req.body;

  if (!clientcode || !exchange) {
    return res
      .status(400)
      .json({ error: "clientcode and exchange are required" });
  }

  try {
    const result = await AliceInstrumentService.syncExchangeInstruments({
      clientcode,
      exchange
    });

    return res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("Alice /instruments/sync error:", err);
    return res
      .status(500)
      .json({ error: err.message || "Internal server error" });
  }
});

export default router;
