import { Router } from "express";
import { UpstoxAdapter } from "../adapters/UpstoxAdapter";
import UpstoxTokensModel from "../models/UpstoxTokens";

const router = Router();
const adapter = new UpstoxAdapter();

async function getAccessToken(userId: string) {
  const doc = await UpstoxTokensModel.findOne({ userId }).exec();
  if (!doc || !doc.accessToken) {
    throw new Error("No active Upstox session for userId");
  }
  return doc.accessToken;
}

// GET /api/upstox/index-ltp?userId=ABC123&symbol=NIFTY
router.get("/index-ltp", async (req, res) => {
  try {
    const { userId, symbol } = req.query as any;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }
    if (!symbol) {
      return res.status(400).json({ error: "symbol is required (NIFTY/BANKNIFTY)" });
    }

    const map: Record<string, string> = {
      NIFTY: "NSE_INDEX|Nifty 50",
      BANKNIFTY: "NSE_INDEX|Nifty Bank",
    };

    const key = map[String(symbol).toUpperCase()];
    if (!key) {
      return res.status(400).json({ error: "Unsupported symbol. Use NIFTY or BANKNIFTY" });
    }

    const accessToken = await getAccessToken(String(userId));

    const apiResp = await adapter.getLtp(accessToken, key);
    const data = apiResp?.data || {};
    let entry = data[key as keyof typeof data];
    if (!entry) {
        const altKey = key.replace("|", ":");
        entry = data[altKey as keyof typeof data];
        }

        // 3) last fallback: jo bhi pehla value ho
        if (!entry) {
        const firstVal = Object.values(data)[0];
        if (firstVal && typeof firstVal === "object") {
            entry = firstVal as any;
        }
        }
        const ltp = entry?.last_price;
        if (ltp === undefined) {
            return res.status(500).json({
                error: "LTP not found in Upstox response",
                raw: apiResp,
            });
            }
    // const ltp = apiResp?.data?.[key]?.last_price;

    // if (ltp === undefined) {
    //   return res.status(500).json({
    //     error: "LTP not found in Upstox response",
    //     raw: apiResp,
    //   });
    // }

    return res.json({
      ok: true,
      symbol,
    //   instrument_key: key,
    instrument_key: entry.instrument_token || key,
      ltp,
    });
  } catch (err: any) {
    console.error("index-ltp error", err);
    return res.status(500).json({ ok: false, error: err.message || err });
  }
});

export default router;
