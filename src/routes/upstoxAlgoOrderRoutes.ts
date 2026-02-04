// src/routes/upstoxAlgoOrderRoutes.ts
import { Router } from "express";
import { placeAlgoOptionOrder } from "../services/orderServices";
import UpstoxTokensModel from "../models/UpstoxTokens";

const router = Router();

async function getAccessToken(userId: string) {
  const doc = await UpstoxTokensModel.findOne({ userId }).exec();
  if (!doc || !doc.accessToken) throw new Error("No active Upstox session for userId");
  return doc.accessToken;
}

/**
 * POST /api/upstox/option/algo-order
 * Body:
 * {
 *   "userId": "admin",
 *   "underlyingSymbol": "NIFTY",
 *   "ltp": 24210,
 *   "side": "BUY",
 *   "optionSide": "CE",
 *   "type": "MARKET",
 *   "lots": 1,
 *   "strikesAway": 0,
 *   "expiryMode": "NEAREST"
 * }
 */
router.post("/option/algo-order", async (req, res) => {
  try {
    const {
      userId,
      underlyingSymbol,
      ltp,
      side,
      optionSide,
      type,
      lots,
      strikesAway,
      expiryMode,
      price,
    } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId is required to identify Upstox session" });
    }

    const accessToken = await getAccessToken(userId);

    if (!underlyingSymbol || typeof underlyingSymbol !== "string") {
      return res
        .status(400)
        .json({ error: "underlyingSymbol is required (e.g. NIFTY)" });
    }

    if (!ltp || typeof ltp !== "number") {
      return res
        .status(400)
        .json({ error: "ltp (underlying price) is required as number" });
    }

    const resp = await placeAlgoOptionOrder({
      underlyingSymbol: underlyingSymbol.trim().toUpperCase(),
      ltp,
      side,
      optionSide,
      type,
      lots: Number(lots),
      strikesAway: strikesAway ? Number(strikesAway) : 0,
      expiryMode: expiryMode || "NEAREST",
      price: price ? Number(price) : undefined,
      accessToken,
    });

    res.json(resp);
  } catch (err: any) {
    console.error("ALGO ORDER ERROR:", err);
    res.status(400).json({ error: err.message || err });
  }
});

export default router;
