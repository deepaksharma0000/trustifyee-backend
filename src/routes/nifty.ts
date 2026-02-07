// src/routes/nifty.ts
import express from "express";
import { config } from "../config";
import { getOptionChain } from "../services/NiftyOptionService";

const router = express.Router();

router.get("/option-chain", async (req, res) => {
  if (req.query.ltp && config.nodeEnv === "production") {
    return res.status(400).json({ ok: false, error: "LTP override not allowed in production" });
  }
  const expiry = req.query.expiry ? String(req.query.expiry) : undefined;
  const range = req.query.range ? Number(req.query.range) : 5;
  const symbol = (req.query.symbol as any) || "NIFTY";

  const chain = await getOptionChain(symbol, expiry, range);
  return res.json({ ok: true, data: chain });
});

export default router;
