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
import { getOptionChain } from "../services/NiftyOptionService";
import { v4 as uuidv4 } from "uuid";
import { decrypt, encrypt } from "../utils/encryption";

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

    log.debug("Incoming place order:", { clientcode, orderPayload });

    // Resolve instrument
    const instrument = await InstrumentModel.findOne({
      tradingsymbol: orderPayload.tradingsymbol,
      exchange: orderPayload.exchange
    }).lean() as any;

    if (!instrument) {
      return res.status(400).json({ error: "Instrument not found" });
    }

    const symboltoken = instrument.symboltoken as string;

    // For admin placing for client, we need the client's userId.
    // Encrypt search term to find user with encrypted client_key
    const encryptedClientCode = encrypt(clientcode);
    const targetUser = await User.findOne({ client_key: encryptedClientCode });
    if (!targetUser) {
      return res.status(404).json({ error: "User with this clientcode not found" });
    }

    // Pass the plain-text clientcode for token lookup
    const resp = await placeOrderForClient(targetUser._id, clientcode, orderPayload);

    if (resp && resp.status === false) {
      log.error("AngelOne order placement failed:", resp);
      return res.status(400).json({ ok: false, error: resp.message || "Broker order failed", resp });
    }

    const orderid =
      (resp as any)?.data?.orderid ||
      (resp as any)?.data?.data?.orderid ||
      (resp as any)?.data?.orderId ||
      `BROKER-${uuidv4()}`;

    await Position.create({
      userId: targetUser._id,
      clientcode,
      orderid,
      tradingsymbol: orderPayload.tradingsymbol,
      exchange: orderPayload.exchange,
      side: orderPayload.side,
      quantity: orderPayload.quantity,
      entryPrice: Number(orderPayload.price ?? 0),
      symboltoken,
      strategy: req.body.strategy || "Manual",
      status: "OPEN",
      stopLossPrice: req.body.stopLossPrice ? Number(req.body.stopLossPrice) : undefined,
      targetPrice: req.body.targetPrice ? Number(req.body.targetPrice) : undefined,
    });

    return res.json({ ok: true, resp, orderid });
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
      is_online: true,
      broker_connected: true
    }).lean();

    const instrument = await InstrumentModel.findOne({
      tradingsymbol: orderPayload.tradingsymbol,
      exchange: orderPayload.exchange
    }).lean() as any;

    const symboltoken = instrument?.symboltoken as string | undefined;

    const results = await Promise.all(users.map(async (user: any) => {
      let clientcode = user.client_key;
      if (!clientcode) return { userId: user._id, status: "skipped", reason: "missing client_key" };

      // Decrypt if it looks like an encrypted field (or always decrypt if consistently encrypted)
      try {
        clientcode = decrypt(clientcode);
      } catch (e) {
        log.warn("Failed to decrypt clientcode for user:", user._id);
      }

      if (user.licence === "Demo") {
        const paperOrderId = `PAPER-${uuidv4()}`;
        await Position.create({
          userId: user._id,
          clientcode,
          orderid: paperOrderId,
          tradingsymbol: orderPayload.tradingsymbol,
          exchange: orderPayload.exchange,
          side: orderPayload.side,
          quantity: orderPayload.quantity,
          entryPrice: Number(orderPayload.price ?? 0),
          symboltoken,
          strategy: req.body.strategy || "Manual",
          status: "OPEN",
          mode: "paper",
          stopLossPrice: req.body.stopLossPrice ? Number(req.body.stopLossPrice) : undefined,
          targetPrice: req.body.targetPrice ? Number(req.body.targetPrice) : undefined,
        });
        return { userId: user._id, status: "paper", orderid: paperOrderId };
      }

      try {
        const resp = await placeOrderForClient(user._id, clientcode, orderPayload);

        // 🔥 Verify if the broker actually accepted the order
        if (resp && (resp.status === false || resp.status === "error")) {
          return { userId: user._id, status: "error", error: resp.message || "Broker rejected the order" };
        }

        const orderid = (resp as any)?.data?.orderid || (resp as any)?.data?.data?.orderid || `BROKER-${uuidv4()}`;

        await Position.create({
          userId: user._id,
          clientcode,
          orderid,
          tradingsymbol: orderPayload.tradingsymbol,
          exchange: orderPayload.exchange,
          side: orderPayload.side,
          quantity: orderPayload.quantity,
          entryPrice: Number(orderPayload.price ?? 0),
          symboltoken,
          strategy: req.body.strategy || "Manual",
          status: "OPEN",
          mode: "live",
          stopLossPrice: req.body.stopLossPrice ? Number(req.body.stopLossPrice) : undefined,
          targetPrice: req.body.targetPrice ? Number(req.body.targetPrice) : undefined,
        });

        return { userId: user._id, status: "ok", orderid };
      } catch (err: any) {
        return { userId: user._id, status: "error", error: err.message || String(err) };
      }
    }));

    return res.json({ ok: true, totalUsers: users.length, results });
  } catch (err: any) {
    log.error("place-all error", err.message || err);
    return res.status(500).json({ error: err.message || err });
  }
});

// 🔥 NEW: Place order for the logged-in user themselves
router.post("/place-user", auth, async (req, res) => {
  const user = (req as any).user;
  let clientcode = user.client_key;

  if (user.licence === "Live" && !clientcode) {
    return res.status(400).json({ error: "No broker client code assigned to your account" });
  }

  // Decrypt clientcode for token lookup
  if (clientcode) {
    try {
      clientcode = decrypt(clientcode);
    } catch (e) {
      log.warn("Failed to decrypt clientcode for user:", user._id);
    }
  }

  try {
    const { symbol, optiontype, side, quantity, ordertype, producttype } = req.body;
    let { tradingsymbol, symboltoken } = req.body;

    // Auto-resolve ATM if tradingsymbol is missing but symbol/optiontype provided
    if (!tradingsymbol && symbol && optiontype) {
      const chain = await getOptionChain(symbol.toUpperCase());
      const atmStrike = chain.atmStrike;
      const match = chain.options.find((o: any) => o.strike === atmStrike && o.optiontype === optiontype.toUpperCase());

      if (!match) return res.status(400).json({ error: `Could not find ATM ${optiontype} for ${symbol}` });

      tradingsymbol = match.tradingsymbol;
      symboltoken = match.symboltoken;
    }

    if (!tradingsymbol) return res.status(400).json({ error: "tradingsymbol required" });

    const orderPayload: PlaceOrderInput = {
      exchange: "NFO",
      tradingsymbol,
      side: side || "BUY",
      transactiontype: side || "BUY",
      quantity: Number(quantity) || 1,
      ordertype: ordertype || "MARKET",
      price: 0,
      producttype: producttype || "INTRADAY",
      symboltoken
    };

    if (user.licence === "Demo") {
      const paperOrderId = `PAPER-${uuidv4()}`;
      await Position.create({
        userId: user._id,
        clientcode: clientcode || "DEMO-USER",
        orderid: paperOrderId,
        tradingsymbol: orderPayload.tradingsymbol,
        exchange: "NFO",
        side: orderPayload.side,
        quantity: orderPayload.quantity,
        entryPrice: 0,
        symboltoken: orderPayload.symboltoken,
        strategy: req.body.strategy || "Manual",
        status: "OPEN",
        mode: "paper",
        stopLossPrice: req.body.stopLossPrice ? Number(req.body.stopLossPrice) : undefined,
        targetPrice: req.body.targetPrice ? Number(req.body.targetPrice) : undefined,
      });
      return res.json({ ok: true, message: "Paper trade executed", orderid: paperOrderId });
    }

    const resp = await placeOrderForClient(user._id, clientcode, orderPayload);

    if (resp && resp.status === false) {
      return res.status(400).json({ ok: false, error: resp.message || "Broker order failed", resp });
    }

    const orderid = (resp as any)?.data?.orderid || (resp as any)?.data?.data?.orderid || `BROKER-${uuidv4()}`;

    await Position.create({
      userId: user._id,
      clientcode,
      orderid,
      tradingsymbol: orderPayload.tradingsymbol,
      exchange: "NFO",
      side: orderPayload.side,
      quantity: orderPayload.quantity,
      entryPrice: 0,
      symboltoken: orderPayload.symboltoken,
      strategy: req.body.strategy || "Manual",
      status: "OPEN",
      mode: "live",
      stopLossPrice: req.body.stopLossPrice ? Number(req.body.stopLossPrice) : undefined,
      targetPrice: req.body.targetPrice ? Number(req.body.targetPrice) : undefined,
    });

    return res.json({ ok: true, resp, orderid });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || err });
  }
});

router.get("/status/:clientcode/:orderId", auth, async (req: any, res) => {
  try {
    const { clientcode, orderId } = req.params;
    const userId = req.id;
    const resp = await getOrderStatusForClient(userId, clientcode, orderId);
    return res.json({ ok: true, resp });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || err });
  }
});

export default router;

