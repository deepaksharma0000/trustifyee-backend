import { Router } from "express";
import { placeOptionOrder } from "../services/orderServices";
import UpstoxTokensModel from "../models/UpstoxTokens";
import { auth, adminOnly } from "../middleware/auth.middleware";

const router = Router();

async function getAccessToken(userId: string) {
  const doc = await UpstoxTokensModel.findOne({ userId }).exec();
  if (!doc || !doc.accessToken) throw new Error("No active Upstox session for userId");
  return doc.accessToken;
}

router.post("/order/place", auth, adminOnly, async (req, res) => {
  try {
    const {
      userId,
      instrument_key,
      lots,
      side,
      type,
      price
    } = req.body;

    if (!userId) {
      // Optional: For backward compatibility, if no userId, we might try to rely on env token?
      // But user specifically wants to avoid env token.
      // So we should enforce userId if we want to be "production friendly" for multiple users.
      // However, if the user hasn't updated their frontend, this might break.
      // Let's make it required to fix the "hardcoded token" issue properly.
      return res.status(400).json({ error: "userId is required to identify Upstox session" });
    }

    if (!instrument_key)
      return res.status(400).json({ error: "instrument_key is required" });

    const accessToken = await getAccessToken(userId);

    const response = await placeOptionOrder(
      instrument_key,
      Number(lots),
      side,
      type,
      price ? Number(price) : 0,
      accessToken
    );

    res.json(response);

  } catch (error: any) {
    console.error("ORDER ROUTE ERROR:", error);
    res.status(400).json({ error: error.message });
  }
});

export default router;
