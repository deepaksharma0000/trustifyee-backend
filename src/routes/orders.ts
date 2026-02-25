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
import AngelTokensModel from "../models/AngelTokens";
import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import { placeAngelOrder } from "../services/angel.service";
import { BrokerResponse } from "../models/BrokerResponse";
import {
  getGlobalTradeHistory,
  getUniqueSymbols,
  exportGlobalTradeHistory
} from "../controllers/order.controller";

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
        if (resp && (resp.status === false || resp.status === "error" || resp.errorcode)) {
          const errMsg = resp.message || resp.error || "Broker rejected the order";

          await BrokerResponse.create({
            userId: user._id,
            clientcode,
            tradingsymbol: orderPayload.tradingsymbol,
            action: "BROADCAST_ORDER",
            status: "REJECTED",
            message: errMsg,
            brokerError: resp
          });

          return { userId: user._id, status: "error", error: errMsg };
        }

        const orderid = (resp as any)?.data?.orderid || (resp as any)?.data?.data?.orderid || `BROKER-${uuidv4()}`;

        // 🕒 WAIT for Broker RMS to process (1.5 - 2 seconds)
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 🔍 Fetch REAL Status from Broker
        let actualStatus = "SUCCESS";
        let actualMessage = "Order placed successfully";
        let finalBrokerData = resp;

        try {
          const statusResp = await getOrderStatusForClient(user._id, clientcode, orderid);
          let brokerData = statusResp?.data || statusResp;

          if (Array.isArray(brokerData)) {
            brokerData = brokerData[0];
          }

          if (brokerData && typeof brokerData === 'object') {
            finalBrokerData = brokerData;
            // Use String() to safely handle potential boolean status
            const bStatus = String(brokerData.orderstatus || brokerData.status || "").toUpperCase();

            if (bStatus === "REJECTED") {
              actualStatus = "REJECTED";
              actualMessage = brokerData.text || brokerData.message || "Rejected by Broker RMS";
            } else if (bStatus === "CANCELLED") {
              actualStatus = "REJECTED";
              actualMessage = "Order Cancelled by Broker";
            } else if (bStatus === "COMPLETE") {
              actualStatus = "SUCCESS";
              actualMessage = "Order executed successfully";
            } else if (bStatus === "OPEN" || bStatus === "PENDING") {
              actualStatus = "SUCCESS";
              actualMessage = "Order is open/pending in broker terminal";
            }
          } else {
            actualStatus = "ERROR";
            actualMessage = "Broker returned empty status response";
          }
        } catch (statusErr: any) {
          log.warn(`Status check failed for ${orderid}:`, statusErr.message);
          actualStatus = "ERROR";
          actualMessage = "Sync failed: " + statusErr.message;
        }

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
          status: actualStatus === "REJECTED" ? "REJECTED" : "OPEN",
          mode: "live",
          stopLossPrice: req.body.stopLossPrice ? Number(req.body.stopLossPrice) : undefined,
          targetPrice: req.body.targetPrice ? Number(req.body.targetPrice) : undefined,
        });

        // Log ACTUAL Response
        await BrokerResponse.create({
          userId: user._id,
          clientcode,
          orderid,
          tradingsymbol: orderPayload.tradingsymbol,
          action: "BROADCAST_ORDER",
          status: (actualStatus === "ERROR" ? "REJECTED" : actualStatus) as any, // Map error to rejected for user clarity
          message: actualMessage,
          brokerError: finalBrokerData
        });

        return { userId: user._id, status: actualStatus === "REJECTED" ? "error" : "ok", orderid, message: actualMessage };
      } catch (err: any) {
        const errMsg = err.message || String(err);

        await BrokerResponse.create({
          userId: user._id,
          clientcode,
          tradingsymbol: orderPayload.tradingsymbol,
          action: "BROADCAST_ORDER",
          status: "ERROR",
          message: errMsg
        });

        return { userId: user._id, status: "error", error: errMsg };
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

    // 🕒 WAIT for Broker RMS
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 🔍 Fetch REAL Status from Broker
    let actualStatus = "SUCCESS";
    let actualMessage = "Order placed successfully";
    let finalBrokerData = resp;

    try {
      const statusResp = await getOrderStatusForClient(user._id, clientcode, orderid);
      let brokerData = statusResp?.data || statusResp;

      if (Array.isArray(brokerData)) {
        brokerData = brokerData[0];
      }

      if (brokerData && typeof brokerData === 'object') {
        finalBrokerData = brokerData;
        const bStatus = String(brokerData.orderstatus || brokerData.status || "").toUpperCase();

        if (bStatus === "REJECTED") {
          actualStatus = "REJECTED";
          actualMessage = brokerData.text || brokerData.message || "Rejected by Broker RMS";
        }
      }
    } catch (statusErr: any) {
      log.warn("Direct user status check failed:", statusErr.message);
      actualStatus = "ERROR";
      actualMessage = "Verification failed: " + statusErr.message;
    }

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
      status: actualStatus === "REJECTED" ? "REJECTED" : "OPEN",
      mode: "live",
      stopLossPrice: req.body.stopLossPrice ? Number(req.body.stopLossPrice) : undefined,
      targetPrice: req.body.targetPrice ? Number(req.body.targetPrice) : undefined,
    });

    // Log ACTUAL Response
    await BrokerResponse.create({
      userId: user._id,
      clientcode,
      orderid,
      tradingsymbol: orderPayload.tradingsymbol,
      action: "USER_ORDER",
      status: (actualStatus === "ERROR" ? "REJECTED" : actualStatus) as any,
      message: actualMessage,
      brokerError: finalBrokerData
    });

    if (actualStatus === "REJECTED") {
      return res.status(400).json({ ok: false, error: actualMessage, orderid });
    }

    return res.json({ ok: true, resp, orderid });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || err });
  }
});

router.get("/status/:clientcode/:orderId", auth, async (req: any, res) => {
  try {
    const { clientcode, orderId } = req.params;
    const user = (req as any).user;
    const userType = (req as any).userType;

    // Security check: If user, must match clientcode
    if (userType === 'user' && user.client_key !== clientcode) {
      return res.status(403).json({ ok: false, message: "Unauthorized access to these orders" });
    }

    // Attempt to get live status from broker
    let brokerResp: any = null;
    try {
      brokerResp = await getOrderStatusForClient(user._id, clientcode, orderId);
    } catch (e) {
      log.warn(`Broker status check failed for ${orderId}:`, (e as any).message);
    }

    // Sync with DB
    const order = await Position.findOne({ orderid: orderId });

    if (brokerResp && brokerResp.status && order) {
      const brokerStatus = brokerResp.data?.status || brokerResp.data?.orderstatus;
      if (brokerStatus === "COMPLETE" && order.status === "OPEN") {
        order.status = "CLOSED"; // Adjust status naming convention if needed
        await order.save();
      }
    }

    if (!order) {
      return res.json({ ok: true, resp: brokerResp });
    }

    return res.json({
      ok: true,
      resp: brokerResp,
      dbStatus: order.status
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || err });
  }
});

// --- MERGED FROM order.routes.ts ---

router.post("/save", auth, adminOnly, async (req, res) => {
  try {
    const {
      clientcode,
      orderid,
      tradingsymbol,
      exchange,
      side,
      quantity,
      price,
      symboltoken,
      autoSquareOffEnabled,
      autoSquareOffTime
    } = req.body;

    const MarketStatusService = require("../services/MarketStatusService").MarketStatusService;
    try {
      MarketStatusService.validateOrderRequest();
    } catch (err: any) {
      return res.status(400).json({ ok: false, message: err.message });
    }

    if (autoSquareOffEnabled && autoSquareOffTime) {
      const exitDate = new Date(autoSquareOffTime);
      if (isNaN(exitDate.getTime())) {
        throw new Error("Invalid auto square-off time");
      }
    }

    const newPosition = await Position.create({
      clientcode,
      orderid,
      tradingsymbol,
      exchange,
      side,
      quantity,
      entryPrice: price || 0,
      symboltoken,
      stopLossPrice: (req.body as any).stopLossPrice,
      targetPrice: (req.body as any).targetPrice,
      status: "OPEN",
      autoSquareOffEnabled: autoSquareOffEnabled || false,
      autoSquareOffTime: autoSquareOffTime ? new Date(autoSquareOffTime) : undefined,
      autoSquareOffStatus: autoSquareOffEnabled ? "PENDING" : undefined
    });

    if (autoSquareOffEnabled && autoSquareOffTime) {
      const AutoExitService = require("../services/AutoExitService").AutoExitService;
      const jobId = await AutoExitService.scheduleExit(orderid, new Date(autoSquareOffTime));
      newPosition.autoSquareOffJobId = jobId;
      await newPosition.save();
    }

    res.json({ ok: true });
  } catch (err: any) {
    log.error("Save order error:", err.message);
    res.status(500).json({ ok: false, message: "Save order failed", error: err.message });
  }
});

router.post("/close", auth, adminOnly, async (req, res) => {
  try {
    const { clientcode, orderid } = req.body;

    const MarketStatusService = require("../services/MarketStatusService").MarketStatusService;
    try {
      MarketStatusService.validateOrderRequest();
    } catch (err: any) {
      return res.status(400).json({ ok: false, message: err.message });
    }

    const position = await Position.findOne({
      clientcode,
      orderid,
      status: "OPEN",
    });

    if (!position) {
      return res.status(404).json({ ok: false, message: "Open position not found" });
    }

    const exitSide = position.side === "BUY" ? "SELL" : "BUY";

    const angelResp = await placeAngelOrder({
      clientcode,
      tradingsymbol: position.tradingsymbol,
      exchange: position.exchange,
      side: exitSide,
      quantity: position.quantity,
      ordertype: "MARKET",
    });

    if (!angelResp?.ok) {
      return res.status(400).json({ ok: false, message: angelResp?.error || "Angel exit order failed" });
    }

    position.status = "CLOSED";
    position.exitOrderId = angelResp.resp?.data?.orderid || "MANUAL";
    position.exitAt = new Date();
    await position.save();

    if (position.autoSquareOffEnabled && position.autoSquareOffJobId) {
      const AutoExitService = require("../services/AutoExitService").AutoExitService;
      await AutoExitService.cancelExit(position.orderid);
      position.autoSquareOffStatus = "CANCELLED";
      await position.save();
    }

    res.json({ ok: true, message: "Position squared off successfully", orderid: position.exitOrderId });
  } catch (err: any) {
    log.error("Close order error:", err.message);
    res.status(500).json({ ok: false, message: "Failed to close position" });
  }
});

router.get("/active-positions/:clientcode", auth, async (req, res) => {
  try {
    const { clientcode } = req.params;
    const user = (req as any).user;
    const userType = (req as any).userType;

    if (userType === 'user' && user.client_key !== clientcode) {
      return res.status(403).json({ ok: false, message: "Unauthorized access" });
    }

    const positions = await Position.find({ clientcode, status: "OPEN" }).sort({ createdAt: -1 }).lean();
    if (positions.length === 0) return res.json({ ok: true, data: [] });

    const tokens = await AngelTokensModel.findOne({ clientcode });
    if (!tokens?.jwtToken) return res.status(401).json({ ok: false, message: "No active session" });

    const adapter = new AngelOneAdapter();
    const positionsWithLtp = await Promise.all(positions.map(async (p) => {
      try {
        let currentSymbolToken = p.symboltoken;
        if (!currentSymbolToken) {
          const inst = await InstrumentModel.findOne({ tradingsymbol: p.tradingsymbol, exchange: p.exchange });
          currentSymbolToken = inst?.symboltoken;
        }

        if (currentSymbolToken) {
          const ltpResp = await adapter.getLtp(tokens.jwtToken!, p.exchange, p.tradingsymbol, currentSymbolToken);
          const ltp = ltpResp?.data?.ltp || 0;
          const pnl = p.side === "BUY" ? (ltp - p.entryPrice) * p.quantity : (p.entryPrice - ltp) * p.quantity;
          return { ...p, ltp, pnl };
        }
        return { ...p, ltp: 0, pnl: 0 };
      } catch (err) {
        return { ...p, ltp: 0, pnl: 0 };
      }
    }));

    res.json({ ok: true, data: positionsWithLtp });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

router.get("/trade-history/:clientcode", auth, async (req, res) => {
  try {
    const { clientcode } = req.params;
    const user = (req as any).user;
    const userType = (req as any).userType;

    if (userType === 'user' && user.client_key !== clientcode) {
      return res.status(403).json({ ok: false, message: "Unauthorized access" });
    }

    const history = await Position.find({ clientcode, status: "CLOSED" }).sort({ exitAt: -1 }).lean();
    res.json({ ok: true, data: history });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

router.get("/broker-responses", auth, async (req: any, res) => {
  try {
    const userId = req.id;
    // Get last 50 responses for this user
    const responses = await BrokerResponse.find({ userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json({ ok: true, data: responses });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err.message || String(err) });
  }
});

router.get("/history-all", auth, adminOnly, getGlobalTradeHistory);
router.get("/unique-symbols", auth, adminOnly, getUniqueSymbols);
router.get("/export-all", auth, adminOnly, exportGlobalTradeHistory);

export default router;

