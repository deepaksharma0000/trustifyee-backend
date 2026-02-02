// src/routes/aliceOrders.ts
import express from "express";
import {
  placeAliceOrderForClient,
  getAliceOrderStatusForClient,
  AlicePlaceOrderInput
} from "../services/AliceOrderService";
import { log } from "../utils/logger";

const router = express.Router();

router.post("/place", async (req, res) => {
  const { clientcode } = req.body;
  if (!clientcode) {
    return res.status(400).json({ error: "clientcode required" });
  }

  try {
    const qtyNum = Number(req.body.quantity);
    if (!qtyNum || Number.isNaN(qtyNum) || qtyNum <= 0) {
      return res.status(400).json({ error: "Valid quantity required" });
    }

    const orderPayload: AlicePlaceOrderInput = {
      exchange: (req.body.exchange || "").toString().toUpperCase(),
      tradingsymbol: req.body.tradingsymbol,
      side: req.body.side,
      transactiontype: req.body.transactiontype,
      quantity: qtyNum,
      ordertype: req.body.ordertype,
      price: req.body.price ?? 0,
      producttype: req.body.producttype,
      duration: req.body.duration,
      symboltoken: req.body.symboltoken,
      triggerPrice: req.body.triggerPrice
    };

    log.debug("Alice Incoming place order:", { clientcode, orderPayload });

    const resp = await placeAliceOrderForClient(clientcode, orderPayload);
    return res.json({ ok: true, resp });
  } catch (err: any) {
    log.error("Alice place order error", err.message || err);
    return res.status(500).json({ error: err.message || err });
  }
});

router.get("/status/:clientcode/:orderId", async (req, res) => {
  try {
    const { clientcode, orderId } = req.params;
    const resp = await getAliceOrderStatusForClient(clientcode, orderId);
    return res.json({ ok: true, resp });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || err });
  }
});

export default router;
