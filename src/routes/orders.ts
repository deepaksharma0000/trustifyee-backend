// src/routes/orders.ts
import express from "express";
import {
  placeOrderForClient,
  getOrderStatusForClient,
  PlaceOrderInput
} from "../services/OrderService";
import { log } from "../utils/logger";
import { auth, adminOnly } from "../middleware/auth.middleware";
import User from "../models/User";
import { Position } from "../models/Position.model";
import InstrumentModel from "../models/Instrument";
import { v4 as uuidv4 } from "uuid";

const router = express.Router();

router.post("/place", auth, adminOnly, async (req, res) => {
  const { clientcode } = req.body;
  if (!clientcode) {
    return res.status(400).json({ error: "clientcode required" });
  }

  try {
    const qtyNum = Number(req.body.quantity);
    if (!qtyNum || Number.isNaN(qtyNum) || qtyNum <= 0) {
      return res.status(400).json({ error: "Valid quantity required" });
    }

    const orderPayload: PlaceOrderInput = {
      exchange: (req.body.exchange).toString().toUpperCase(),
      tradingsymbol: req.body.tradingsymbol,
      side: req.body.side,
      transactiontype: req.body.transactiontype || req.body.side,
      quantity: qtyNum,
      ordertype: req.body.ordertype,
      price: req.body.price ?? 0,
      producttype: req.body.producttype,
      duration: req.body.duration,
      symboltoken: req.body.symboltoken,
      triggerPrice: req.body.triggerPrice
    };

    log.debug("Incoming place order:", { clientcode, orderPayload });

    const resp = await placeOrderForClient(clientcode, orderPayload);

    if (resp && resp.status === false) {
      log.error("AngelOne order placement failed:", resp);
      return res.status(400).json({ ok: false, error: resp.message || "Broker order failed", resp });
    }

    return res.json({ ok: true, resp });
  } catch (err: any) {
    log.error("place order error", err.message || err);
    return res.status(500).json({ error: err.message || err });
  }
});

router.post("/place-all", auth, adminOnly, async (req, res) => {
  try {
    const qtyNum = Number(req.body.quantity);
    if (!qtyNum || Number.isNaN(qtyNum) || qtyNum <= 0) {
      return res.status(400).json({ error: "Valid quantity required" });
    }

    if (!req.body.tradingsymbol || !req.body.side) {
      return res.status(400).json({ error: "tradingsymbol and side required" });
    }

    const orderPayload: PlaceOrderInput = {
      exchange: (req.body.exchange || "NFO").toString().toUpperCase(),
      tradingsymbol: req.body.tradingsymbol,
      side: req.body.side,
      transactiontype: req.body.transactiontype || req.body.side,
      quantity: qtyNum,
      ordertype: req.body.ordertype || "MARKET",
      price: req.body.price ?? 0,
      producttype: req.body.producttype,
      duration: req.body.duration,
      symboltoken: req.body.symboltoken,
      triggerPrice: req.body.triggerPrice
    };

    const users = await User.find({
      status: "active",
      trading_status: "enabled",
    }).lean();

    const instrument = await InstrumentModel.findOne({
      tradingsymbol: orderPayload.tradingsymbol,
      exchange: "NFO"
    }).lean();
    const symboltoken = instrument?.symboltoken;

    const results = await Promise.all(users.map(async (user: any) => {
      const clientcode = user.client_key;
      if (!clientcode) {
        return { userId: user._id, status: "skipped", reason: "missing client_key" };
      }

      // Demo users: paper trade only
      if (user.licence === "Demo") {
        const paperOrderId = `PAPER-${uuidv4()}`;
        await Position.create({
          clientcode,
          orderid: paperOrderId,
          tradingsymbol: orderPayload.tradingsymbol,
          exchange: orderPayload.exchange,
          side: orderPayload.side,
          quantity: orderPayload.quantity,
          entryPrice: Number(orderPayload.price ?? 0),
          symboltoken,
          status: "OPEN",
        });
        return { userId: user._id, status: "paper", orderid: paperOrderId };
      }

      try {
        const resp = await placeOrderForClient(clientcode, orderPayload);
        const orderid =
          (resp as any)?.data?.orderid ||
          (resp as any)?.data?.data?.orderid ||
          (resp as any)?.data?.orderId ||
          (resp as any)?.data?.data?.orderId ||
          `BROKER-${uuidv4()}`;

        await Position.create({
          clientcode,
          orderid,
          tradingsymbol: orderPayload.tradingsymbol,
          exchange: orderPayload.exchange,
          side: orderPayload.side,
          quantity: orderPayload.quantity,
          entryPrice: Number(orderPayload.price ?? 0),
          symboltoken,
          status: "OPEN",
        });

        return { userId: user._id, status: "ok", orderid };
      } catch (err: any) {
        return { userId: user._id, status: "error", error: err.message || String(err) };
      }
    }));

    return res.json({
      ok: true,
      totalUsers: users.length,
      results
    });
  } catch (err: any) {
    log.error("place-all error", err.message || err);
    return res.status(500).json({ error: err.message || err });
  }
});

router.get("/status/:clientcode/:orderId", async (req, res) => {
  try {
    const { clientcode, orderId } = req.params;
    const resp = await getOrderStatusForClient(clientcode, orderId);
    return res.json({ ok: true, resp });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || err });
  }
});

export default router;
