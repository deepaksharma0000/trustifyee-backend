import { Router } from "express";
import { placeOptionOrder } from "../services/orderServices";

const router = Router();

router.post("/order/place", async (req, res) => {
  try {
    const {
      instrument_key,
      lots,
      side,
      type,
      price
    } = req.body;

    if (!instrument_key)
      return res.status(400).json({ error: "instrument_key is required" });

    const response = await placeOptionOrder(
      instrument_key,
      Number(lots),
      side,
      type,
      price ? Number(price) : 0
    );

    res.json(response);

  } catch (error: any) {
    console.error("ORDER ROUTE ERROR:", error);
    res.status(400).json({ error: error.message });
  }
});

export default router;
