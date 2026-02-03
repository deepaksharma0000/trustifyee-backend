// src/routes/nifty.ts
import express from "express";
import { getOptionChain } from "../services/NiftyOptionService";

const router = express.Router();

router.get("/option-chain", async (req, res) => {
  const ltp = req.query.ltp ? Number(req.query.ltp) : undefined;
  const symbol = (req.query.symbol as any) || "NIFTY";

  const chain = await getOptionChain(symbol, ltp);
  return res.json({ ok: true, data: chain });
});

export default router;
