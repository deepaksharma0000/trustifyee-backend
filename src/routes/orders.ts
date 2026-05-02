// src/routes/orders.ts
import express from "express";
import {
  placeOrderForClient,
  getOrderStatusForClient,
  PlaceOrderInput
} from "../services/OrderService";
import log from "../utils/logger";
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
        broadcastLtp = (ltpResp as any)?.data?.ltp || (ltpResp as any)?.ltp || 0;
        if (broadcastLtp === 0 && ltpResp?.data) {
          broadcastLtp = Number(ltpResp.data.lastPrice || 0);
        }
      }
    } catch (e: any) { log.warn("LTP fetch failed in /place:", e.message); }

    // 🚀 [COMPLIANCE FIX] Generate a signal instead of placing a server-side order
    const { SignalService } = await import("../services/SignalService");
    const signal = await SignalService.createSignal({
      symbol: orderPayload.tradingsymbol,
      exchange: orderPayload.exchange,
      side: orderPayload.side as any,
      tradingsymbol: orderPayload.tradingsymbol,
      price: Number(orderPayload.price) || 0,
      quantity: orderPayload.quantity,
      strategy: req.body.strategy || "AdminManual",
      signalType: req.body.signalType || "ENTRY",
    });

    return res.json({ 
      ok: true, 
      message: "Signal generated and pushed to user device.", 
      signalId: signal?._id 
    });
  } catch (err: any) {
    log.error("place order (signal) error", err.message || err);
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

    // 🚀 [COMPLIANCE FIX] Generate ONE broadcast signal via SignalService
    // All connected users will receive this TRADE_SIGNAL via WebSocket and execute it locally.
    const { SignalService } = await import("../services/SignalService");
    const signal = await SignalService.createSignal({
      symbol: orderPayload.tradingsymbol,
      exchange: orderPayload.exchange,
      side: orderPayload.side as any,
      tradingsymbol: orderPayload.tradingsymbol,
      price: Number(orderPayload.price) || 0,
      quantity: orderPayload.quantity,
      strategy: targetStrategy,
      signalType: req.body.signalType || "ENTRY",
      executionMode: "SERVER" // 🔥 Inform frontend to skip local execution
    });

    // 🚀 NEW: Trigger Server-Side Execution Engine (Queue + Outbox)
    const { SignalBroadcastService } = await import("../services/SignalBroadcastService");
    const broadcastResult = await SignalBroadcastService.broadcast(signal?._id.toString());

    return res.json({ 
      ok: true, 
      message: `Broadcast initiated for ${broadcastResult.totalUsers} users.`, 
      signalId: signal?._id,
      ...broadcastResult
    });
  } catch (err: any) {
    log.error("place-all signal error", err.message || err);
    return res.status(500).json({ error: err.message || err });
  }
});

// 🔥 [COMPLIANCE] Disabled: User must execute from their own device via the frontend engine
router.post("/place-user", auth, async (_req, res) => {
  log.warn("[LEGACY_ROUTE_CALLED] /api/orders/place-user called. Resource is Gone.");
  return res.status(410).json({
    status: false,
    code: 'USER_DEVICE_EXECUTION_REQUIRED',
    error: "Server-side execution disabled. Use the integrated user-device executor in the dashboard."
  });
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

    // 🚀 [COMPLIANCE FIX] Generate an EXIT signal via SignalService
    const { SignalService } = await import("../services/SignalService");
    const signal = await SignalService.createSignal({
      symbol: position.tradingsymbol,
      exchange: position.exchange,
      side: exitSide,
      tradingsymbol: position.tradingsymbol,
      price: 0, 
      quantity: position.quantity,
      strategy: (position as any).strategy || "ManualExit",
      signalType: "EXIT",
    });

    res.json({ 
      ok: true, 
      message: "Exit signal generated and pushed to user device.", 
      signalId: signal?._id 
    });
  } catch (err: any) {
    log.error("Close order (signal) error:", err.message);
    res.status(500).json({ ok: false, message: "Failed to generate exit signal" });
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

