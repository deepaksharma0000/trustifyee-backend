// src/routes/orders.ts
import express from "express";
import {
  placeOrderForClient,
  getOrderStatusForClient,
  getAngelOrderBookForClient,
  PlaceOrderInput
} from "../services/OrderService";
import log from "../utils/logger";
import { auth, adminOnly } from "../middleware/auth.middleware";
import { Position } from "../models/Position.model";
import InstrumentModel from "../models/Instrument";
import { matchesEncryptedValue } from "../utils/encryption";
import AngelTokensModel from "../models/AngelTokens";
import { AutoExitService } from "../services/AutoExitService";
import { MarketStatusService } from "../services/MarketStatusService";
import { BrokerResponse } from "../models/BrokerResponse";
import { SignalExecutionResult } from "../models/SignalExecutionResult";
import { getTradeQueueForBroker } from "../utils/tradeQueue";
import {
  getGlobalTradeHistory,
  getUniqueSymbols,
  exportGlobalTradeHistory
} from "../controllers/order.controller";
import moment from "moment-timezone";
import { findUserByClientCode } from "../utils/clientCodeLookup";
import { config } from "../config";
import { decrypt } from "../utils/encryption";
import User from "../models/User";
import { getConnectedUserIds, isUserSocketConnected } from "../services/UserSocketService";
import { v4 as uuidv4 } from "uuid";

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
    const targetUser = await findUserByClientCode(clientcode);
    if (!targetUser) {
      return res.status(404).json({ error: "User with this clientcode not found" });
    }

    // Capture LTP as fallback
    let broadcastLtp = 0;
    try {
      const { createAngelAdapter } = await import('../utils/broker');
      const adapter = await createAngelAdapter(targetUser._id.toString());
      const tokens = await AngelTokensModel.findOne({
        userId: targetUser._id,
        clientcode,
        jwtToken: { $exists: true, $ne: "" }
      })
        .sort({ updatedAt: -1 })
        .lean();
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
    const { SignalBroadcastService } = await import("../services/SignalBroadcastService");

    const signal = await SignalService.createSignal({
      symbol: orderPayload.tradingsymbol,
      exchange: orderPayload.exchange,
      side: orderPayload.side as any,
      tradingsymbol: orderPayload.tradingsymbol,
      price: Number(orderPayload.price) || 0,
      quantity: orderPayload.quantity,
      strategy: req.body.strategy || "AdminManual",
      signalType: req.body.signalType || "ENTRY",
      executionMode: req.body.executionMode === "SERVER" || req.body.clientcode ? "SERVER" : "CLIENT"
    });

    // If admin explicitly targets a client, queue execution only for that user.
    if (req.body.clientcode) {
      const clientOrderId = `ADMIN-${String(signal?._id).slice(-4)}-${String(targetUser._id).slice(-4)}-${Date.now().toString().slice(-4)}`;
      const correlationId = uuidv4();
      const broker = String(targetUser.broker || "ANGELONE").toUpperCase();

      await SignalExecutionResult.findOneAndUpdate(
        { signalId: signal?._id, userId: targetUser._id },
        {
          signalId: signal?._id,
          userId: targetUser._id,
          clientOrderId,
          broker,
          status: "PENDING",
          correlationId,
          source: "SERVER_QUEUE",
          errorMessage: undefined,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      const queue = getTradeQueueForBroker(broker);
      await queue.add(
        `admin-exec-${clientOrderId}`,
        {
          userId: String(targetUser._id),
          signalId: String(signal?._id),
          clientOrderId,
          correlationId,
          clientCode: clientcode,
          outgoingIp: Boolean((targetUser as any)?.dedicated_ip_enabled === true)
            ? ((targetUser as any).outgoing_ip || undefined)
            : undefined,
          agentUrl: Boolean((targetUser as any)?.dedicated_ip_enabled === true)
            ? ((targetUser as any).agent_url || undefined)
            : undefined,
          dedicatedIpEnabled: Boolean((targetUser as any)?.dedicated_ip_enabled === true),
          orderData: {
            exchange: signal?.exchange || orderPayload.exchange,
            tradingsymbol: signal?.tradingsymbol || orderPayload.tradingsymbol,
            side: signal?.side || orderPayload.side,
            quantity: orderPayload.quantity,
            strategy: req.body.strategy || "AdminManual",
            symboltoken: signal?.symboltoken || symboltoken,
            broker,
          },
        },
        {
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
          jobId: `admin-signal-exec-${clientOrderId}`,
        }
      );

      return res.json({
        ok: true,
        message: "Real-time server-side execution queued for selected client.",
        signalId: signal?._id,
        clientOrderId,
      });
    }

    // If admin requests broadcast server-mode, queue across mapped users by strategy.
    if (req.body.executionMode === "SERVER") {
      await SignalBroadcastService.executeBroadcast(signal as any);
      return res.json({
        ok: true,
        message: "Real-time server-side strategy execution triggered.",
        signalId: signal?._id
      });
    }

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

    if (!instrument && !orderPayload.symboltoken) {
      return res.status(400).json({ error: "Instrument not found and symboltoken missing" });
    }

    const { validateInstrumentFromMaster } = await import("../services/InstrumentValidationService");
    const instrumentCheck = await validateInstrumentFromMaster({
      exchange: orderPayload.exchange,
      tradingsymbol: orderPayload.tradingsymbol,
      requestedToken: orderPayload.symboltoken,
      allowExpired: false,
    });
    if (!instrumentCheck.valid) {
      const reason = instrumentCheck.reason || "INSTRUMENT_INVALID";
      log.warn("[PLACE_ALL] Rejected broadcast — instrument validation failed", {
        tradingsymbol: orderPayload.tradingsymbol,
        exchange: orderPayload.exchange,
        reason,
      });
      return res.status(400).json({
        ok: false,
        status: false,
        code: reason,
        error:
          reason === "EXPIRED_OPTION_CONTRACT"
            ? `Option contract expired: ${orderPayload.exchange}:${orderPayload.tradingsymbol}. Refresh option chain and select current expiry.`
            : `${reason}: ${orderPayload.exchange}:${orderPayload.tradingsymbol}`,
      });
    }
    if (instrumentCheck.symboltoken) {
      orderPayload.symboltoken = instrumentCheck.symboltoken;
    }

    const targetStrategy = req.body.strategy || "Manual";
    const preflightOnly =
      req.body?.preflightOnly === true ||
      String(req.query?.preflightOnly || "").toLowerCase() === "true";

    // Admin broadcast defaults to SERVER: enqueue per-user broker jobs on the VPS worker.
    // CLIENT mode only when explicitly requested (browser signal executor path).
    const requestedExecutionMode = String(
      req.body?.executionMode || req.query?.executionMode || "SERVER"
    )
      .trim()
      .toUpperCase();
    const forceClientDispatch = requestedExecutionMode === "CLIENT";
    const forceServerDispatch = !forceClientDispatch;

    const allowClientFallbackOnBlocked =
      String(process.env.PLACE_ALL_CLIENT_FALLBACK_ON_BLOCK || "false").toLowerCase() === "true";
    const autoClientOnIpRisk =
      String(process.env.PLACE_ALL_CLIENT_ON_IP_RISK || "false").toLowerCase() === "true";

    const BroadcastSvc = (await import("../services/SignalBroadcastService")).SignalBroadcastService;
    const readiness = await BroadcastSvc.getBroadcastReadinessReport(targetStrategy);
    const blockedDetails = (readiness.details || []).filter((d: any) => d.ready === false);
    const executionRows = (readiness.details || []).map((d: any) => {
      const isSocketConnected = Boolean(d?.userId && isUserSocketConnected(String(d.userId)));
      const online = Boolean(d?.isOnlineDb) || isSocketConnected;
      const serverQueueable = forceServerDispatch && d?.ready !== false;
      const clientQueueable = forceClientDispatch && online;
      const queueable = serverQueueable || clientQueueable;
      return {
        userId: d.userId || null,
        userName: d.userName || d.email || null,
        licence: d.licence || "Live",
        broker: d.broker || null,
        online: forceServerDispatch ? queueable : online,
        status: queueable ? "QUEUED" : forceServerDispatch ? "BLOCKED" : "OFFLINE",
        message: serverQueueable
          ? "Server execution queued - processing on broker worker."
          : clientQueueable
          ? "Signal dispatched for user-side execution."
          : forceServerDispatch
          ? d?.reason || "User broker route is not ready for server-side execution."
          : "User device is offline. Signal will execute when user reconnects and polls pending signals.",
        usedIp: d.usedIp || null,
        networkRoute: d.routeType || null,
      };
    });
    const onlineUsers = executionRows.filter((r: any) => r.online === true).length;
    const offlineUsers = executionRows.length - onlineUsers;
    const liveUsers = (readiness.details || []).filter(
      (d: any) => String(d.licence || "Live").toLowerCase() === "live"
    ).length;
    const demoUsers = Math.max(0, readiness.totalUsers - liveUsers);
    const blockedStaticIpCount = blockedDetails.filter((d: any) => {
      const text = String(d?.reason || d?.lastBrokerMessage || "").toLowerCase();
      return (
        text.includes("unregistered ip") ||
        text.includes("register your ip") ||
        text.includes("static ip")
      );
    }).length;
    const hasStaticIpRiskForAllUsers =
      readiness.totalUsers > 0 && blockedStaticIpCount > 0 && blockedStaticIpCount === readiness.totalUsers;

    let useClientDispatch = forceClientDispatch;
    if (forceServerDispatch && autoClientOnIpRisk && hasStaticIpRiskForAllUsers) {
      log.warn("[PLACE_ALL] Static IP risk detected for all users but SERVER dispatch retained.", {
        strategy: targetStrategy,
        blockedStaticIpCount,
      });
    }

    if (preflightOnly) {
      return res.json({
        ok: true,
        status: true,
        preflightOnly: true,
        message: "Broadcast preflight report generated.",
        preflight: {
          strategy: readiness.strategy,
          totalUsers: readiness.totalUsers,
          readyUsers: readiness.readyUsers,
          blockedUsers: readiness.blockedUsers,
          blockedDetails,
        },
      });
    }

    const { SignalService } = await import("../services/SignalService");

    if (useClientDispatch) {
      const connectedUserIds = getConnectedUserIds();
      log.info("[PLACE_ALL_CLIENT_DISPATCH]", {
        strategy: targetStrategy,
        totalUsers: readiness.totalUsers,
        onlineUsers,
        offlineUsers,
        connectedUsers: connectedUserIds.length,
        connectedUserIds,
      });

      const signal = await SignalService.createSignal({
        symbol: orderPayload.tradingsymbol,
        exchange: orderPayload.exchange,
        side: orderPayload.side as any,
        tradingsymbol: orderPayload.tradingsymbol,
        price: Number(orderPayload.price) || 0,
        quantity: orderPayload.quantity,
        strategy: targetStrategy,
        signalType: req.body.signalType || "ENTRY",
        executionMode: "CLIENT",
      });

      return res.json({
        ok: true,
        status: true,
        dispatchMode: "CLIENT_ONLY",
        message: "Signal dispatched for user-side execution.",
        signalId: signal?._id,
        totalUsers: readiness.totalUsers,
        queued: onlineUsers,
        failed: 0,
        offlineSkipped: offlineUsers,
        livePlaced: liveUsers,
        demoPlaced: demoUsers,
        executions: executionRows,
        preflight: {
          strategy: readiness.strategy,
          totalUsers: readiness.totalUsers,
          readyUsers: readiness.readyUsers,
          blockedUsers: readiness.blockedUsers,
          blockedDetails,
        },
      });
    }

    if (readiness.readyUsers === 0) {
      const firstBlocked = blockedDetails[0] || null;
      const blockedReason =
        String(firstBlocked?.reason || "").trim() ||
        "No broker-ready users for this strategy. Broadcast skipped.";

      if (allowClientFallbackOnBlocked) {
        log.warn("[PLACE_ALL_CLIENT_FALLBACK]", {
          strategy: targetStrategy,
          totalUsers: readiness.totalUsers,
          onlineUsers,
          offlineUsers,
          blockedReason,
        });

        const signal = await SignalService.createSignal({
          symbol: orderPayload.tradingsymbol,
          exchange: orderPayload.exchange,
          side: orderPayload.side as any,
          tradingsymbol: orderPayload.tradingsymbol,
          price: Number(orderPayload.price) || 0,
          quantity: orderPayload.quantity,
          strategy: targetStrategy,
          signalType: req.body.signalType || "ENTRY",
          executionMode: "CLIENT",
        });

        return res.status(200).json({
          ok: true,
          status: true,
          dispatchMode: "CLIENT_FALLBACK",
          warning: blockedReason,
          message: "Server-side broker route blocked. Signal dispatched for user-side execution.",
          signalId: signal?._id,
          totalUsers: readiness.totalUsers,
          queued: onlineUsers,
          failed: 0,
          offlineSkipped: offlineUsers,
          livePlaced: liveUsers,
          demoPlaced: demoUsers,
          executions: executionRows,
          preflight: {
            strategy: readiness.strategy,
            totalUsers: readiness.totalUsers,
            readyUsers: readiness.readyUsers,
            blockedUsers: readiness.blockedUsers,
            blockedDetails,
            firstBlockedUser: firstBlocked
              ? {
                  userId: firstBlocked.userId || null,
                  userName: firstBlocked.userName || firstBlocked.email || null,
                  routeType: firstBlocked.routeType || null,
                  usedIp: firstBlocked.usedIp || null,
                  lastBrokerMessage: firstBlocked.lastBrokerMessage || null,
                  lastBrokerUsedIp: firstBlocked.lastBrokerUsedIp || null,
                }
              : null,
          },
        });
      }

      return res.status(200).json({
        ok: false,
        status: false,
        code: "NO_BROKER_READY_USERS",
        error: blockedReason,
        message: blockedReason,
        preflight: {
          strategy: readiness.strategy,
          totalUsers: readiness.totalUsers,
          readyUsers: readiness.readyUsers,
          blockedUsers: readiness.blockedUsers,
          blockedDetails,
          firstBlockedUser: firstBlocked
            ? {
                userId: firstBlocked.userId || null,
                userName: firstBlocked.userName || firstBlocked.email || null,
                routeType: firstBlocked.routeType || null,
                usedIp: firstBlocked.usedIp || null,
                lastBrokerMessage: firstBlocked.lastBrokerMessage || null,
                lastBrokerUsedIp: firstBlocked.lastBrokerUsedIp || null,
              }
            : null,
        },
      });
    }

    const signal = await SignalService.createSignal({
      symbol: orderPayload.tradingsymbol,
      exchange: orderPayload.exchange,
      side: orderPayload.side as any,
      tradingsymbol: orderPayload.tradingsymbol,
      price: Number(orderPayload.price) || 0,
      quantity: orderPayload.quantity,
      strategy: targetStrategy,
      signalType: req.body.signalType || "ENTRY",
      executionMode: "SERVER"
    });

    const broadcastResult = await BroadcastSvc.broadcast(signal?._id.toString());

    return res.json({
      ok: true,
      status: true,
      dispatchMode: "SERVER_BROADCAST",
      message: `Broadcast initiated for ${broadcastResult.totalUsers} users.`,
      signalId: signal?._id,
      preflight: {
        strategy: readiness.strategy,
        totalUsers: readiness.totalUsers,
        readyUsers: readiness.readyUsers,
        blockedUsers: readiness.blockedUsers,
        blockedDetails,
      },
      ...broadcastResult
    });
  } catch (err: any) {
    log.error("place-all signal error", err.message || err);
    return res.status(500).json({ error: err.message || err });
  }
});
router.post("/place-user", auth, async (req, res) => {
  try {
    const user = (req as any).user;
    const { symbol, optiontype, side, quantity, strategy, producttype } = req.body;
    let { tradingsymbol, symboltoken } = req.body;

    log.info("[PLACE_USER] Compliant manual signal generation requested:", {
      userId: user?._id,
      symbol,
      optiontype,
      side,
      quantity,
      strategy
    });

    // 1. Auto-resolve ATM contract if missing but symbol & optiontype provided
    if (!tradingsymbol && symbol && optiontype) {
      const { getOptionChain } = await import("../services/NiftyOptionService");
      const normalizedSym = symbol.toUpperCase().replace("-", "").replace(" ", "") as any;
      const chain = await getOptionChain(normalizedSym);
      const atmStrike = chain.atmStrike;
      const match = chain.options.find(
        (o: any) => o.strike === atmStrike && String(o.optiontype).toUpperCase() === String(optiontype).toUpperCase()
      );

      if (!match) {
        return res.status(400).json({
          ok: false,
          status: false,
          error: `Could not resolve ATM ${optiontype} for ${symbol}`
        });
      }

      tradingsymbol = match.tradingsymbol;
      symboltoken = match.symboltoken;
    }

    if (!tradingsymbol) {
      return res.status(400).json({
        ok: false,
        status: false,
        error: "tradingsymbol is required or could not be resolved."
      });
    }

    // 2. Generate a compliant TRADE_SIGNAL via SignalService
    const { SignalService } = await import("../services/SignalService");
    const signal = await SignalService.createSignal({
      symbol: symbol || tradingsymbol,
      exchange: "NFO",
      side: (side || "BUY").toUpperCase() as any,
      tradingsymbol,
      strike: undefined,
      optiontype: optiontype ? (optiontype.toUpperCase() as any) : undefined,
      price: 0, // Market order
      quantity: Number(quantity) || 1,
      strategy: strategy || "Manual",
      signalType: "ENTRY",
      executionMode: "CLIENT"
    });

    log.info(`[PLACE_USER] Compliant signal generated: ${signal._id} for ${user?._id}`);

    // Return exact keys expected by the frontend: ok: true, orderid (mapped to signalId)
    return res.json({
      ok: true,
      status: true,
      message: "Order signal generated and pushed to your device. Direct execution starting...",
      signalId: signal?._id,
      orderid: signal?._id
    });
  } catch (err: any) {
    log.error("[PLACE_USER] Compliant signal generation failed:", err.message || err);
    return res.status(500).json({
      ok: false,
      status: false,
      error: err.message || "Internal server error"
    });
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
    if (userType === 'user' && !matchesEncryptedValue(user.client_key || "", clientcode)) {
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

    if (userType === 'user' && !matchesEncryptedValue(user.client_key || "", clientcode)) {
      return res.status(403).json({ ok: false, message: "Unauthorized access" });
    }

    const positions = await Position.find({ clientcode, status: "OPEN" }).sort({ createdAt: -1 }).lean();
    if (positions.length === 0) return res.json({ ok: true, data: [] });

    // Strict user/client scoped session to avoid cross-user token mix.
    const tokenQuery: any = { clientcode };
    if (userType === "user") {
      tokenQuery.userId = user._id;
    }

    let tokens = await AngelTokensModel.findOne(tokenQuery);

    if (!tokens?.jwtToken) {
      // For Live users, this is a hard error. For Demo, we might have failed fallback too.
      if (user.licence === "Live") return res.status(401).json({ ok: false, message: "No active session" });

      // If Demo but no fallback token, return positions without LTP
      return res.json({ ok: true, data: positions.map(p => ({ ...p, ltp: 0, pnl: 0 })) });
    }

    const { createAngelAdapter } = await import("../utils/broker");
    const adapter = await createAngelAdapter(tokens.userId?.toString() || (req as any).id);
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

    if (userType === 'user' && !matchesEncryptedValue(user.client_key || "", clientcode)) {
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
        const targetUser = await findUserByClientCode(req.query.clientcode as string);
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

router.get("/angel-order-book", auth, async (req: any, res) => {
  try {
    let userId = String(req.id || "");
    let clientcode = "";

    if (req.userType === "admin") {
      if (req.query.userId) {
        userId = String(req.query.userId);
      }
      if (req.query.clientcode) {
        clientcode = String(req.query.clientcode).trim().toUpperCase();
      } else if (userId) {
        const targetUser = await User.findById(userId).select("+client_key").lean();
        if (targetUser?.client_key) {
          clientcode = decrypt(targetUser.client_key, `angel_order_book_${userId}`).trim().toUpperCase();
        }
      }
    } else {
      const user = await User.findById(userId).select("+client_key").lean();
      if (!user?.client_key) {
        return res.status(400).json({ ok: false, message: "Client code missing. Connect broker first." });
      }
      clientcode = decrypt(user.client_key, `angel_order_book_${userId}`).trim().toUpperCase();
    }

    if (!clientcode) {
      return res.status(400).json({ ok: false, message: "Client code required" });
    }

    if (req.userType === "user") {
      const user = await User.findById(userId).select("+client_key").lean();
      if (!user?.client_key || !matchesEncryptedValue(user.client_key, clientcode)) {
        return res.status(403).json({ ok: false, message: "Unauthorized access to this Angel One account" });
      }
    }

    const orderBook = await getAngelOrderBookForClient(userId, clientcode);

    const platformExecutions = await SignalExecutionResult.find({ userId })
      .sort({ updatedAt: -1 })
      .limit(50)
      .select(
        "signalId status orderId clientOrderId brokerOrderStatus brokerRejectReason errorMessage executedAt updatedAt ipAddress source"
      )
      .lean();

    return res.json({
      ok: true,
      clientcode,
      angelOne: orderBook,
      platformExecutions,
    });
  } catch (err: any) {
    log.error("[angel-order-book] fetch failed", { message: err?.message });
    return res.status(500).json({ ok: false, message: err.message || "Failed to fetch Angel One order book" });
  }
});

router.get("/broadcast-readiness", auth, adminOnly, async (req: any, res) => {
  try {
    const strategy = typeof req.query.strategy === "string" && req.query.strategy.trim()
      ? req.query.strategy.trim()
      : "Manual";
    const blockedOnly = String(req.query.blockedOnly || "").toLowerCase() === "true";

    const { SignalBroadcastService } = await import("../services/SignalBroadcastService");
    const report = await SignalBroadcastService.getBroadcastReadinessReport(strategy);

    const details = blockedOnly
      ? (report.details || []).filter((row: any) => row.ready === false)
      : report.details;

    const enrichedDetails = (details || []).map((row: any) => ({
      ...row,
      socketConnected: Boolean(row?.isOnlineDb) || Boolean(row?.userId && isUserSocketConnected(String(row.userId))),
    }));

    return res.json({
      ok: true,
      strategy: report.strategy,
      totalUsers: report.totalUsers,
      readyUsers: report.readyUsers,
      blockedUsers: report.blockedUsers,
      connectedUsers: getConnectedUserIds(),
      details: enrichedDetails,
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, message: err.message || String(err) });
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
