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
import { AutoExitService } from "../services/AutoExitService";
import { MarketStatusService } from "../services/MarketStatusService";
import { BrokerResponse } from "../models/BrokerResponse";
import {
  getGlobalTradeHistory,
  getUniqueSymbols,
  exportGlobalTradeHistory
} from "../controllers/order.controller";
import moment from "moment-timezone";

const router = express.Router();

router.post("/place", async (req, res, next) => {
  // Allow internal system calls to bypass auth
  if (req.headers['x-system-secret'] === 'INTERNAL_JOB_SECRET') {
    (req as any).user = { role: 'admin', user_name: 'SYSTEM' };
    (req as any).userType = 'admin';
    return next();
  }
  return auth(req, res, next);
}, adminOnly, async (req, res) => {
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

    // Resolve instrument
    const instrument = await InstrumentModel.findOne({
      tradingsymbol: orderPayload.tradingsymbol,
      exchange: orderPayload.exchange
    }).lean() as any;

    if (!instrument) {
      return res.status(400).json({ error: "Instrument not found" });
    }

    // Resolve instrument lot size for expansion
    if (instrument && instrument.instrumenttype === "OPTIDX" && instrument.lotSize) {
      if (orderPayload.quantity < 500) { // Threshold for lot-to-unit expansion
        orderPayload.quantity = orderPayload.quantity * instrument.lotSize;
      }
    }

    const symboltoken = instrument.symboltoken as string;

    // For admin placing for client, we need the client's userId.
    // Encrypt search term to find user with encrypted client_key
    const encryptedClientCode = encrypt(clientcode);
    const targetUser = await User.findOne({ client_key: encryptedClientCode });
    if (!targetUser) {
      return res.status(404).json({ error: "User with this clientcode not found" });
    }

    // Capture LTP as fallback
    let broadcastLtp = 0;
    try {
        const adapter = new AngelOneAdapter();
        const tokens = await AngelTokensModel.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({updatedAt: -1});
        if (tokens?.jwtToken && symboltoken) {
            const ltpResp = await adapter.getLtp(tokens.jwtToken, "NFO", orderPayload.tradingsymbol, symboltoken);
            broadcastLtp = ltpResp?.data?.ltp || ltpResp?.ltp || 0;
            if (broadcastLtp === 0 && ltpResp?.data) {
                broadcastLtp = Number(ltpResp.data.lastPrice || 0);
            }
        }
    } catch (e) { log.warn("LTP fetch failed in /place:", e.message); }

    // Pass the plain-text clientcode for token lookup
    const resp = await placeOrderForClient(targetUser._id, clientcode, orderPayload);

    if (resp && resp.status === false) {
      log.error("AngelOne order placement failed:", resp);
      return res.status(400).json({ ok: false, error: resp.message || "Broker order failed", resp });
    }

    const orderid =
      (resp as any)?.data?.orderid ||
      (resp as any)?.data?.data?.orderid ||
      (resp as any)?.orderId ||
      (resp as any)?.orderid ||
      `BROKER-${uuidv4()}`;

    if (orderid.startsWith("BROKER-")) {
        log.warn(`Broker confirmation missing in /place for ${clientcode}. Resp:`, JSON.stringify(resp));
    }

    // Capture real entry price if possible
    let entryPrice = 0;
    if (resp?.ok !== false) {
       try {
           // Allow small delay for broker execution
           await new Promise(r => setTimeout(r, 2000));
           const statusResp = await getOrderStatusForClient(targetUser._id, clientcode, orderid);
           let bData = statusResp?.data || statusResp;
           if (Array.isArray(bData)) bData = bData[0];
           
           if (bData && (bData.averageprice || bData.price)) {
               entryPrice = Number(bData.averageprice || bData.price);
           }
       } catch (e) { log.warn("Price capture failed in /place:", e.message); }
    }

    if (entryPrice === 0) entryPrice = broadcastLtp;

    await Position.create({
      userId: targetUser._id,
      clientcode,
      orderid,
      tradingsymbol: orderPayload.tradingsymbol,
      exchange: orderPayload.exchange,
      side: orderPayload.side,
      quantity: orderPayload.quantity,
      entryPrice: entryPrice,
      symboltoken,
      strategy: req.body.strategy || "Manual",
      status: "OPEN",
      stopLossPrice: req.body.stopLossPrice ? Number(req.body.stopLossPrice) : undefined,
      targetPrice: req.body.targetPrice ? Number(req.body.targetPrice) : undefined,
      tradeType: req.body.tradeType || "Manual",
      signalTime: new Date(),
      productType: req.body.producttype || "INTRADAY",
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

    const instrument = await InstrumentModel.findOne({
      tradingsymbol: orderPayload.tradingsymbol,
      exchange: orderPayload.exchange
    }).lean() as any;

    // Expansion for broadcast as well
    if (instrument && instrument.instrumenttype === "OPTIDX" && instrument.lotSize) {
      if (orderPayload.quantity < 500) {
        orderPayload.quantity = orderPayload.quantity * instrument.lotSize;
      }
    }

    const users = await User.find({
      status: "active",
      trading_status: "enabled",
      is_online: true,
      broker_connected: true
    }).lean();

    const symboltoken = instrument?.symboltoken as string | undefined;

    // Capture LTP ONCE for all users in broadcast
    let broadcastLtp = 0;
    try {
        const adapter = new AngelOneAdapter();
        // Use any active admin token
        const tokens = await AngelTokensModel.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 });
        if (tokens?.jwtToken && symboltoken) {
            const ltpResp = await adapter.getLtp(tokens.jwtToken, "NFO", orderPayload.tradingsymbol, symboltoken);
            broadcastLtp = ltpResp?.data?.ltp || ltpResp?.ltp || 0;
            if (broadcastLtp === 0 && ltpResp?.data) {
                // Secondary check for different response format
                broadcastLtp = Number(ltpResp.data.lastPrice || 0);
            }
        }
    } catch (e) { log.warn("LTP fetch for broadcast failed:", e.message); }

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
          entryPrice: broadcastLtp,
          symboltoken,
          strategy: req.body.strategy || "Manual",
          status: "OPEN",
          mode: "paper",
          stopLossPrice: req.body.stopLossPrice ? Number(req.body.stopLossPrice) : undefined,
          targetPrice: req.body.targetPrice ? Number(req.body.targetPrice) : undefined,
          tradeType: req.body.tradeType || "Manual",
          signalTime: new Date(),
          productType: req.body.producttype || "INTRADAY",
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

        const orderid = (resp as any)?.data?.orderid || (resp as any)?.data?.data?.orderid || (resp as any)?.orderid || `BROKER-${uuidv4()}`;
        
        if (orderid.startsWith("BROKER-")) {
            log.warn(`Broker confirmation missing for user ${user.clientcode}. Using UUID: ${orderid}. Full Resp:`, JSON.stringify(resp));
        }

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

        // Capture Price
        let entryPrice = 0;
        if (actualStatus === "SUCCESS") {
            try {
                const bData = finalBrokerData;
                entryPrice = Number(bData?.averageprice || bData?.price || 0);
            } catch (e) {}
        }
        if (entryPrice === 0 && actualStatus === "SUCCESS") entryPrice = broadcastLtp;

        await Position.create({
          userId: user._id,
          clientcode,
          orderid,
          tradingsymbol: orderPayload.tradingsymbol,
          exchange: orderPayload.exchange,
          side: orderPayload.side,
          quantity: orderPayload.quantity,
          entryPrice: entryPrice,
          symboltoken,
          strategy: req.body.strategy || "Manual",
          status: actualStatus === "REJECTED" ? "REJECTED" : "OPEN",
          mode: "live",
          stopLossPrice: req.body.stopLossPrice ? Number(req.body.stopLossPrice) : undefined,
          targetPrice: req.body.targetPrice ? Number(req.body.targetPrice) : undefined,
          tradeType: req.body.tradeType || "Manual",
          signalTime: new Date(),
          productType: req.body.producttype || "INTRADAY",
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

    const instrument = await InstrumentModel.findOne({
      tradingsymbol: tradingsymbol || "",
      exchange: "NFO"
    }).lean() as any;

    let finalQuantity = Number(quantity) || 1;
    if (instrument && instrument.instrumenttype === "OPTIDX" && instrument.lotSize) {
      // If quantity is small (e.g. 1, 2, 5), assume it's lots and expand to units
      // If it's already a multiple of lotSize and > lotSize, it might be units already.
      // But usually, Admin/User inputs lots in these specific UI fields.
      if (finalQuantity < 500) { // Safety threshold: if qty < 500, likely lots
         finalQuantity = finalQuantity * instrument.lotSize;
      }
    }

    const orderPayload: PlaceOrderInput = {
      exchange: "NFO",
      tradingsymbol,
      side: side || "BUY",
      transactiontype: side || "BUY",
      quantity: finalQuantity,
      ordertype: ordertype || "MARKET",
      price: 0,
      producttype: producttype || "INTRADAY",
      symboltoken
    };

    // Capture LTP BEFORE deciding Demo vs Live for both fallback and demo entry
    let paperEntryPrice = 0;
    try {
        const adapter = new AngelOneAdapter();
        // Try to get any active admin/user token
        const tokens = await AngelTokensModel.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({updatedAt: -1});
        if (tokens?.jwtToken && symboltoken) {
            const ltpResp = await adapter.getLtp(tokens.jwtToken, "NFO", tradingsymbol, symboltoken);
            paperEntryPrice = ltpResp?.data?.ltp || ltpResp?.ltp || 0;
            if (paperEntryPrice === 0 && ltpResp?.data) paperEntryPrice = Number(ltpResp.data.lastPrice || 0);
        }
    } catch (e) { log.error("LTP fetch for paper trade failed", e.message); }

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
        entryPrice: paperEntryPrice,
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

    const orderid = (resp as any)?.data?.orderid || (resp as any)?.data?.data?.orderid || (resp as any)?.orderid || `BROKER-${uuidv4()}`;

    if (orderid.startsWith("BROKER-")) {
        log.warn(`Broker confirmation missing in /place-user for ${clientcode}. Resp:`, JSON.stringify(resp));
    }

    // 🕒 WAIT for Broker RMS
    await new Promise(resolve => setTimeout(resolve, 2000));

    let entryPrice = 0;
    let actualStatus = "SUCCESS";
    let actualMessage = "Order Placed Successfully";
    let finalBrokerData = null;

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
        
        // Capture REAL entry price
        entryPrice = Number(brokerData.averageprice || brokerData.price || 0);
      }
    } catch (statusErr: any) {
      log.warn("Direct user status check failed:", statusErr.message);
      actualStatus = "ERROR";
      actualMessage = "Verification failed: " + statusErr.message;
    }
    
    // Fallback to paperEntryPrice (LTP) if order is complete but averageprice is 0
    if (actualStatus === "SUCCESS" && entryPrice === 0) {
        entryPrice = paperEntryPrice;
    }

    await Position.create({
      userId: user._id,
      clientcode,
      orderid,
      tradingsymbol: orderPayload.tradingsymbol,
      exchange: "NFO",
      side: orderPayload.side,
      quantity: orderPayload.quantity,
      entryPrice: entryPrice,
      symboltoken: orderPayload.symboltoken,
      strategy: req.body.strategy || "Manual",
      status: actualStatus === "REJECTED" ? "REJECTED" : "OPEN",
      mode: "live",
      stopLossPrice: req.body.stopLossPrice ? Number(req.body.stopLossPrice) : undefined,
      targetPrice: req.body.targetPrice ? Number(req.body.targetPrice) : undefined,
      tradeType: req.body.tradeType || "Manual",
      signalTime: new Date(),
      productType: req.body.producttype || "INTRADAY",
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

router.get("/status/:clientcode/:orderId", async (req, res, next) => {
  if (req.headers['x-system-secret'] === 'INTERNAL_JOB_SECRET') {
    (req as any).user = { role: 'admin', user_name: 'SYSTEM' };
    (req as any).userType = 'admin';
    return next();
  }
  return auth(req, res, next);
}, async (req: any, res) => {
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
      autoSquareOffStatus: autoSquareOffEnabled ? "PENDING" : undefined,
      productType: req.body.producttype || "INTRADAY",
      strategy: req.body.strategy || "Manual",
      tradeType: req.body.tradeType || "Manual",
    });

    if (autoSquareOffEnabled && autoSquareOffTime) {
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

router.post("/close", async (req, res, next) => {
  if (req.headers['x-system-secret'] === 'INTERNAL_JOB_SECRET') {
    (req as any).user = { role: 'admin', user_name: 'SYSTEM' };
    (req as any).userType = 'admin';
    return next();
  }
  return auth(req, res, next);
}, adminOnly, async (req, res) => {
  try {
    const { clientcode, orderid } = req.body;

    try {
      if (req.headers['x-system-secret'] !== 'INTERNAL_JOB_SECRET') {
        MarketStatusService.validateOrderRequest();
      }
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

    const orderInput: PlaceOrderInput = {
      exchange: position.exchange,
      tradingsymbol: position.tradingsymbol,
      side: exitSide,
      transactiontype: exitSide,
      quantity: position.quantity,
      ordertype: "MARKET",
      producttype: position.productType as any || "INTRADAY",
      symboltoken: position.symboltoken
    };

    const resp = await placeOrderForClient(position.userId, clientcode, orderInput);

    if (resp && resp.status === false) {
      return res.status(400).json({ ok: false, message: resp.message || "Broker exit order failed" });
    }

    const orderid_resp = resp?.data?.orderid || resp?.data?.data?.orderid || "MANUAL";

    // Fetch Exit Price
    let exitPrice = 0;
    try {
        const tokens = await AngelTokensModel.findOne({ clientcode });
        if (tokens?.jwtToken && position.symboltoken) {
            const adapter = new AngelOneAdapter();
            const ltpResp = await adapter.getLtp(tokens.jwtToken, position.exchange, position.tradingsymbol, position.symboltoken);
            exitPrice = ltpResp?.data?.ltp || 0;
        }
    } catch (e) {
        log.warn("Failed to fetch exit price during square off", e);
    }

    position.status = "CLOSED";
    position.exitOrderId = orderid_resp;
    position.exitQty = position.quantity;
    position.exitPrice = exitPrice || position.targetPrice || position.stopLossPrice; // Fallback to target/SL as user suggested
    position.exitAt = new Date();
    await position.save();

    if (position.autoSquareOffEnabled && position.autoSquareOffJobId) {
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

// 🔥 NEW: Update Auto Exit Time for an existing position
router.post("/update-auto-exit", auth, adminOnly, async (req, res) => {
  try {
    const { orderid, autoSquareOffTime, autoSquareOffEnabled } = req.body;
    log.info(`[AutoExitRoute] Request for ${orderid}:`, { autoSquareOffTime, autoSquareOffEnabled });

    if (!orderid) return res.status(400).json({ ok: false, message: "orderid required" });

    const position = await Position.findOne({ orderid });
    if (!position) {
      log.warn(`[AutoExitRoute] Position ${orderid} not found`);
      return res.status(404).json({ ok: false, message: "Position not found" });
    }

    // 1. Cancel existing job if any
    try {
      if (position.autoSquareOffJobId) {
        log.debug(`[AutoExitRoute] Cancelling previous job ${position.autoSquareOffJobId}`);
        await AutoExitService.cancelExit(orderid);
      }
    } catch (cancelErr) {
      log.warn(`[AutoExitRoute] Cancel job failed for ${orderid} (ignoring):`, cancelErr);
    }

    // 2. Schedule new job if enabled
    let jobId: string | undefined = undefined;
    let finalExitDate: Date | undefined = undefined;

    if (autoSquareOffEnabled && autoSquareOffTime) {
      const istDate = moment.tz(autoSquareOffTime, "Asia/Kolkata");
      if (!istDate.isValid()) {
        throw new Error("Invalid date format provided");
      }

      finalExitDate = istDate.toDate();
      log.info(`[AutoExitRoute] Scheduling new job at ${istDate.format()} for ${orderid}`);
      jobId = await AutoExitService.scheduleExit(orderid, autoSquareOffTime);
    }

    // 3. Update DB
    position.autoSquareOffEnabled = autoSquareOffEnabled;
    position.autoSquareOffTime = finalExitDate;
    position.autoSquareOffJobId = jobId;
    position.autoSquareOffStatus = autoSquareOffEnabled ? "PENDING" : "CANCELLED";

    await position.save();
    log.info(`[AutoExitRoute] Successfully updated DB for ${orderid}`);

    res.json({ ok: true, message: "Auto exit updated successfully" });
  } catch (err: any) {
    log.error("[AutoExitRoute] Error:", err.message);
    res.status(500).json({ ok: false, message: err.message || "Internal server error" });
  }
});

export default router;

