// src/routes/nifty.ts
import express from "express";
import { getNiftyOptionChain } from "../services/NiftyOptionService";

const router = express.Router();

router.get("/option-chain", async (req, res) => {
    console.log("✅ Nifty routes loaded");

  const niftyLtp = Number(req.query.ltp);

  if (!niftyLtp) {
    return res.status(400).json({ error: "nifty ltp required" });
  }

  const chain = await getNiftyOptionChain(niftyLtp);
  return res.json({ ok: true, data: chain });
});

export default router;
