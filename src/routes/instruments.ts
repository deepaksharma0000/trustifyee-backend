import express from "express";
import { syncNiftyOptionsOnly, findSymbolToken,findSymbol } from "../services/InstrumentService";
import { log } from "../utils/logger";

const router = express.Router();


router.post("/sync", async (_req, res) => {
  try {
    await syncNiftyOptionsOnly();
    return res.json({ ok: true });
  } catch (err: any) {
    log.error("instrument sync error", err.message || err);
    return res.status(500).json({ ok: false, error: err.message || err });
  }
});


router.get("/lookup", async (req, res) => {
  const exchange = (req.query.exchange as string) || "";
  const tradingsymbol = (req.query.tradingsymbol as string) || "";

  if (!exchange || !tradingsymbol) {
    return res.status(400).json({ ok: false, error: "exchange & tradingsymbol required" });
  }

  try {
    const symbol = await findSymbol(exchange, tradingsymbol);

    if (!symbol) {
      return res.status(404).json({ ok: false, error: "symboltoken not found" });
    }

    return res.json({
      ok: true,
      data: {
        tradingsymbol: symbol.tradingsymbol,
        symboltoken: symbol.symboltoken,
        exchange: symbol.exchange,
        instrumenttype: symbol.instrumenttype,
        name: symbol.name
      }
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e.message || e });
  }
});

export default router;
