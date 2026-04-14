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
import { Group } from "../models/GroupServices";
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

    const symboltoken = instrument.symboltoken as string;

    // For admin placing for client, we need the client's userId.
    // Encrypt search term to find user with encrypted client_key
    const encryptedClientCode = encrypt(clientcode);
    const targetUser = await User.findOne({ client_key: encryptedClientCode }).lean();
    if (!targetUser) {
      return res.status(404).json({ error: "User with this clientcode not found" });
    }

    // Capture LTP as fallback
    let broadcastLtp = 0;
    try {
      const { createAngelAdapter } = await import('../utils/broker');
      const adapter = await createAngelAdapter(targetUser._id.toString());
      const tokens = await AngelTokensModel.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 }).lean();
      if (tokens?.jwtToken && symboltoken) {
        const ltpResp = await adapter.getLtp(tokens.jwtToken, "NFO", orderPayload.tradingsymbol, symboltoken);
        broadcastLtp = ltpResp?.data?.ltp || ltpResp?.ltp || 0;
        if (broadcastLtp === 0 && ltpResp?.data) {
          broadcastLtp = Number(ltpResp.data.lastPrice || 0);
        }
      }
    } catch (e: any) { log.warn("LTP fetch failed in /place:", e.message); }

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
      } catch (e: any) { log.warn("Price capture failed in /place:", e.message); }
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

    const isOptionChainTrade = req.body.tradeType === "Option-Chain";
    const targetStrategy = req.body.strategy || "Manual";

    const baseSymbol = req.body.tradingsymbol?.replace(/[0-9].*$/, "").trim().toUpperCase() || "";

    // 1. Fetch all groups once for lookup
    const allGroups = await Group.find({}).lean();

    // 2. Find eligible users
    // If strategy is Manual, we also include users with NO strategies defined (legacy support)
    const strategyQuery = targetStrategy === "Manual" 
      ? { $or: [{ strategies: "Manual" }, { strategies: { $size: 0 } }, { strategies: { $exists: false } }] }
      : { strategies: targetStrategy };

    const userQuery: any = {
      status: "active",
      trading_status: "enabled",
      licence: { $in: ["Live", "Demo"] },
      ...strategyQuery
    };

    let users = await User.find(userQuery).lean();

    // 3. Add admin themselves to the processing list
    const adminReqUser = (req as any).user;
    const userType = (req as any).userType;
    if (adminReqUser && adminReqUser._id && userType === 'admin') {
       const AdminModel = require('../models/Admin').default;
       const adminData = await AdminModel.findById(adminReqUser._id).lean();
       if (adminData && !users.find((u: any) => u._id.toString() === adminData._id.toString())) {
           adminData.licence = adminData.broker_connected ? "Live" : "Demo";
           if (!adminData.client_key && adminData.panel_client_key) adminData.client_key = adminData.panel_client_key;
           users.push(adminData as any);
       }
    }

    if (users.length === 0) {
      log.warn(`[PLACE_ALL] Aborted: No active users matched Strategy: ${targetStrategy}`);
      return res.json({ ok: true, totalUsers: 0, message: "No active users found for this strategy." });
    }

    const symboltoken = instrument?.symboltoken as string | undefined;

    // Capture LTP ONCE for all users (using an active session)
    let broadcastLtp = 0;
    try {
      const tokens = await AngelTokensModel.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 }).lean();
      if (tokens?.jwtToken && tokens?.userId && symboltoken) {
        const { createAngelAdapter } = await import('../utils/broker');
        const adapter = await createAngelAdapter(tokens.userId.toString());
        const ltpResp = await adapter.getLtp(tokens.jwtToken, "NFO", orderPayload.tradingsymbol, symboltoken);
        broadcastLtp = ltpResp?.data?.ltp || ltpResp?.ltp || 0;
        if (broadcastLtp === 0 && ltpResp?.data) broadcastLtp = Number(ltpResp.data.lastPrice || 0);
      }
    } catch (e: any) { log.warn("LTP fetch for broadcast failed:", e.message); }

    const enrichedResults = await Promise.all(users.map(async (user: any) => {
      // 4. Resolve Group Service Multiplier
      const groupConfig = allGroups.find(g => g.name === user.group_service);
      
      // Smart search for service (handle spaces in symbols)
      const serviceConfig = groupConfig?.services.find(s => {
          const sName = (s.name || "").toUpperCase().replace(/\s+/g, "");
          const bSym = baseSymbol.replace(/\s+/g, "");
          return sName.includes(bSym) || bSym.includes(sName);
      });

      // If user is in a group but we can't find this specific service, we might skip to avoid wrong trades
      // UNLESS it's the admin themselves or the user has no group.
      if (user.group_service && !serviceConfig && userType !== 'admin') {
          return { userId: user._id, userName: user.user_name, status: "skipped", reason: `Symbol ${baseSymbol} not enabled in Group ${user.group_service}` };
      }

      const userMultiplier = serviceConfig?.group_qty || 1;
      const lotMultiplier = instrument?.lotSize || 1;
      const totalUserUnits = Math.max(1, (orderPayload.quantity * userMultiplier) * lotMultiplier);

      let clientcode = user.client_key;
      const userName = user.user_name || user.name || "N/A";

      if (!clientcode && user.licence !== "Demo") {
          return { userId: user._id, userName, licence: user.licence, status: "skipped", reason: "Missing client_key", brokerConnected: !!user.broker_connected };
      }

      try {
        if (clientcode) clientcode = decrypt(clientcode);
      } catch (e) { log.warn("Decrypt failed for:", user._id); }

      // Order Slicing
      const orderSlices: number[] = [];
      let freezeLimit = baseSymbol === "BANKNIFTY" ? 900 : (baseSymbol === "MIDCPNIFTY" ? 4200 : 1800);
      let rem = totalUserUnits;
      while (rem > 0) {
        const s = Math.min(rem, freezeLimit);
        orderSlices.push(s);
        rem -= s;
      }

      const userSlices: any[] = [];

      for (const sliceQty of orderSlices) {
        if (user.licence === "Demo") {
          const paperOrderId = `PAPER-${uuidv4()}`;
          await Position.create({
            userId: user._id, clientcode: clientcode || "DEMO-USER", orderid: paperOrderId,
            tradingsymbol: orderPayload.tradingsymbol, exchange: orderPayload.exchange,
            side: orderPayload.side, quantity: sliceQty, entryPrice: broadcastLtp,
            symboltoken, strategy: targetStrategy, status: "OPEN", mode: "paper",
            tradeType: req.body.tradeType || "Manual", productType: req.body.producttype || "INTRADAY",
            isSystemGenerated: true,
          });
          userSlices.push({ status: "paper", orderid: paperOrderId });
        } else if (!user.broker_connected) {
          const skippedOrderId = `REJ-${uuidv4()}`;
          await Position.create({
            userId: user._id, clientcode: clientcode || "MISSING-CC", orderid: skippedOrderId,
            tradingsymbol: orderPayload.tradingsymbol, exchange: orderPayload.exchange,
            side: orderPayload.side, quantity: sliceQty, entryPrice: broadcastLtp,
            symboltoken, strategy: targetStrategy, status: "REJECTED", mode: "live",
            tradeType: req.body.tradeType || "Manual", productType: req.body.producttype || "INTRADAY",
            isSystemGenerated: true, userLicenceAtTrade: user.licence,
          });
          userSlices.push({ status: "skipped", reason: "Broker Disconnected" });
        } else {
          try {
            const resp = await placeOrderForClient(user._id, clientcode, { ...orderPayload, quantity: sliceQty });
            
            let actualStatus = "OPEN";
            let brokerMsg = resp?.message || "Order Submitted";
            let orderid = resp?.data?.orderid || resp?.orderid;

            if (resp && resp.status === false) {
                actualStatus = "REJECTED";
                brokerMsg = resp.message || "Rejected by Broker";
                orderid = orderid || `REJ-${uuidv4()}`;
            } else {
                orderid = orderid || `BR-${uuidv4()}`;
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                try {
                    const statusResp = await getOrderStatusForClient(user._id, clientcode, orderid);
                    if (statusResp && statusResp.status && statusResp.data) {
                        const bData = Array.isArray(statusResp.data) ? statusResp.data[0] : statusResp.data;
                        const bStatus = String(bData.orderstatus || bData.status || "").toUpperCase();
                        
                        // 🎯 IMPROVED: If broker text is empty, generate professional message based on status
                        const bStatusText = bData.text || bData.message || bData.cancelreason || "";
                        if (!bStatusText || bStatusText.toUpperCase() === "SUCCESS") {
                            if (bStatus === "COMPLETE") brokerMsg = "Order Executed Successfully";
                            else if (["OPEN", "PENDING", "TRIGGER PENDING"].includes(bStatus)) brokerMsg = "Order is pending in broker terminal";
                            else if (bStatus === "REJECTED") brokerMsg = "Rejected by Broker RMS";
                            else brokerMsg = bStatus || brokerMsg;
                        } else {
                            brokerMsg = bStatusText;
                        }

                        if (["REJECTED", "CANCELLED", "ERROR", "FAILED"].includes(bStatus)) {
                            actualStatus = "REJECTED";
                        } else if (bStatus === "COMPLETE") {
                            actualStatus = "COMPLETE";
                        }
                    }
                } catch (e: any) { log.warn("Broadcast status verification failed:", e.message); }
            }

            await Position.create({
              userId: user._id, clientcode, orderid,
              tradingsymbol: orderPayload.tradingsymbol, exchange: orderPayload.exchange,
              side: orderPayload.side, quantity: sliceQty, entryPrice: broadcastLtp,
              symboltoken, strategy: targetStrategy, status: actualStatus === "COMPLETE" ? "OPEN" : actualStatus, mode: "live",
              tradeType: req.body.tradeType || "Manual", productType: req.body.producttype || "INTRADAY",
              isSystemGenerated: true,
            });

            await BrokerResponse.create({
               userId: user._id, clientcode, orderid, tradingsymbol: orderPayload.tradingsymbol,
               action: "BROADCAST_ORDER", 
               status: actualStatus === "REJECTED" ? "REJECTED" : "SUCCESS", 
               message: brokerMsg, 
               brokerError: resp
            });

            userSlices.push({ status: actualStatus === "REJECTED" ? "error" : "ok", orderid, reason: brokerMsg });
          } catch (err: any) {
            log.error("Broadcast slice error:", err.message);
            userSlices.push({ status: "error", error: err.message });
          }
        }
      }

      const firstSlice = userSlices[0] || {};
      return { 
        userId: user._id, userName, licence: user.licence, 
        totalUnits: totalUserUnits, status: userSlices.some(s => s.status === 'ok' || s.status === 'paper') ? (user.licence === "Demo" ? "paper" : "ok") : "error",
        isOnline: !!user.is_online, brokerConnected: !!user.broker_connected,
        orderid: firstSlice.orderid, reason: firstSlice.reason, error: firstSlice.error
      };
    }));

    return res.json({ ok: true, totalUsers: users.length, results: enrichedResults });
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
      // Try to get any active admin/user token
      const tokens = await AngelTokensModel.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 }).lean();
      if (tokens?.jwtToken && tokens?.userId && symboltoken) {
        const { createAngelAdapter } = await import('../utils/broker');
        const adapter = await createAngelAdapter(tokens.userId.toString());
        const ltpResp = await adapter.getLtp(tokens.jwtToken, "NFO", tradingsymbol, symboltoken);
        paperEntryPrice = ltpResp?.data?.ltp || ltpResp?.ltp || 0;
        if (paperEntryPrice === 0 && ltpResp?.data) paperEntryPrice = Number(ltpResp.data.lastPrice || 0);
      }
    } catch (e: any) { log.error("LTP fetch for paper trade failed", e.message); }

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
        tradeType: req.body.tradeType || "Manual",
        signalTime: new Date(),
        productType: req.body.producttype || "INTRADAY",
      });

      // Simulate Broker Response for realism
      await BrokerResponse.create({
        userId: user._id,
        clientcode: clientcode || "DEMO-USER",
        orderid: paperOrderId,
        tradingsymbol: orderPayload.tradingsymbol,
        action: "USER_ORDER",
        status: "SUCCESS",
        message: "Order Placed Successfully (Demo Mode)",
        brokerError: { message: "SIMULATED_SUCCESS", mode: "PAPER" }
      });

      return res.json({ ok: true, message: "Order placed successfully (Demo)", orderid: paperOrderId });
    }

    const resp = await placeOrderForClient(user._id, clientcode, orderPayload);
    const orderid = (resp as any)?.data?.orderid || (resp as any)?.data?.data?.orderid || (resp as any)?.orderid || `BROKER-${uuidv4()}`;

    let entryPrice = 0;
    let actualStatus = "SUCCESS";
    let actualMessage = "Order Placed Successfully";
    let finalBrokerData = null;

    if (resp && resp.status === false) {
      actualStatus = "REJECTED";
      actualMessage = resp.message || "Broker error";
    } else {
      // 🕒 WAIT for Broker RMS on success submission
      await new Promise(resolve => setTimeout(resolve, 2000));

      try {
        const statusResp = await getOrderStatusForClient(user._id, clientcode, orderid);
        let brokerData = statusResp?.data || statusResp;

        if (Array.isArray(brokerData)) {
          brokerData = brokerData[0];
        }

        if (brokerData && typeof brokerData === 'object') {
          finalBrokerData = brokerData;
          const bStatus = String(brokerData.orderstatus || brokerData.status || "").toUpperCase();

          // 🎯 IMPROVED: Professional message translation
          const bStatusText = brokerData.text || brokerData.message || brokerData.cancelreason || "";
          if (!bStatusText || bStatusText.toUpperCase() === "SUCCESS") {
              if (bStatus === "COMPLETE") actualMessage = "Order Executed Successfully";
              else if (["OPEN", "PENDING", "TRIGGER PENDING"].includes(bStatus)) actualMessage = "Order is pending in broker terminal";
              else if (bStatus === "REJECTED") actualMessage = "Rejected by Broker RMS";
              else actualMessage = bStatus || actualMessage;
          } else {
              actualMessage = bStatusText;
          }

          if (["REJECTED", "CANCELLED", "ERROR", "FAILED"].includes(bStatus)) {
            actualStatus = "REJECTED";
          } else if (bStatus === "COMPLETE") {
            actualStatus = "SUCCESS";
          }

          // Capture REAL entry price
          entryPrice = Number(brokerData.averageprice || brokerData.price || 0);
        }
      } catch (statusErr: any) {
        log.warn("Direct user status check failed:", statusErr.message);
      }
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
      status: (actualStatus === "REJECTED" ? "REJECTED" : "SUCCESS") as any,
      message: actualMessage,
      brokerError: finalBrokerData || resp
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
    const order = await Position.findOne({ orderid: orderId }).lean();

    if (brokerResp && brokerResp.status && order) {
      const brokerStatus = brokerResp.data?.status || brokerResp.data?.orderstatus;
      if (brokerStatus === "COMPLETE" && order.status === "OPEN") {
        await Position.updateOne({ orderid: orderId }, { $set: { status: "CLOSED" } });
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

    // Find position by orderid (which is unique) instead of using clientcode from request, 
    // because clientcode might be 'ADMIN_ALL' when admin is closing the position.
    const position = await Position.findOne({
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

    // Use position's clientcode instead of the one from req.body
    const resp = await placeOrderForClient(position.userId, position.clientcode, orderInput);

    if (resp && resp.status === false) {
      return res.status(400).json({ ok: false, message: resp.message || "Broker exit order failed" });
    }

    const orderid_resp = resp?.data?.orderid || resp?.data?.data?.orderid || "MANUAL";

    // Fetch Exit Price
    let exitPrice = 0;
    try {
      const tokens = await AngelTokensModel.findOne({ clientcode: position.clientcode }).lean();
      if (tokens?.jwtToken && position.symboltoken) {
        if (!position.userId) throw new Error("Position userId missing");
        const { createAngelAdapter } = await import('../utils/broker');
        const adapter = await createAngelAdapter(position.userId.toString());
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

    // Try to get user's session, fallback to any active session for Demo users
    let tokens = await AngelTokensModel.findOne({ clientcode });
    if (!tokens?.jwtToken && user.licence === "Demo") {
      tokens = await AngelTokensModel.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 });
    }

    if (!tokens?.jwtToken) {
      // For Live users, this is a hard error. For Demo, we might have failed fallback too.
      if (user.licence === "Live") return res.status(401).json({ ok: false, message: "No active session" });

      // If Demo but no fallback token, return positions without LTP
      return res.json({ ok: true, data: positions.map(p => ({ ...p, ltp: 0, pnl: 0 })) });
    }

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
    let userId = req.id;

    // Allow admin/sub-admin to view specific user's responses via userId or clientcode
    if (req.userType === 'admin') {
      if (req.query.userId) {
        userId = req.query.userId as string;
      } else if (req.query.clientcode) {
        const encryptedCode = encrypt(req.query.clientcode as string);
        const targetUser = await User.findOne({ client_key: encryptedCode });
        if (targetUser) {
          userId = targetUser._id.toString();
        } else {
          return res.status(404).json({ ok: false, message: "User with this clientcode not found" });
        }
      }
    }

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

