"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/orders.ts
const express_1 = __importDefault(require("express"));
const OrderService_1 = require("../services/OrderService");
const logger_1 = require("../utils/logger");
const auth_middleware_1 = require("../middleware/auth.middleware");
const User_1 = __importDefault(require("../models/User"));
const Position_model_1 = require("../models/Position.model");
const Instrument_1 = __importDefault(require("../models/Instrument"));
const NiftyOptionService_1 = require("../services/NiftyOptionService");
const uuid_1 = require("uuid");
const encryption_1 = require("../utils/encryption");
const AngelTokens_1 = __importDefault(require("../models/AngelTokens"));
const AngelOneAdapter_1 = require("../adapters/AngelOneAdapter");
const AutoExitService_1 = require("../services/AutoExitService");
const MarketStatusService_1 = require("../services/MarketStatusService");
const BrokerResponse_1 = require("../models/BrokerResponse");
const order_controller_1 = require("../controllers/order.controller");
const moment_timezone_1 = __importDefault(require("moment-timezone"));
const router = express_1.default.Router();
router.post("/place", async (req, res, next) => {
    // Allow internal system calls to bypass auth
    if (req.headers['x-system-secret'] === 'INTERNAL_JOB_SECRET') {
        req.user = { role: 'admin', user_name: 'SYSTEM' };
        req.userType = 'admin';
        return next();
    }
    return (0, auth_middleware_1.auth)(req, res, next);
}, auth_middleware_1.adminOnly, async (req, res) => {
    const { clientcode } = req.body;
    if (!clientcode) {
        return res.status(400).json({ error: "clientcode required" });
    }
    try {
        const qtyNum = Number(req.body.quantity);
        if (!qtyNum || Number.isNaN(qtyNum) || qtyNum <= 0) {
            return res.status(400).json({ error: "Valid quantity required" });
        }
        const orderPayload = {
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
        logger_1.log.debug("Incoming place order:", { clientcode, orderPayload });
        // Resolve instrument
        const instrument = await Instrument_1.default.findOne({
            tradingsymbol: orderPayload.tradingsymbol,
            exchange: orderPayload.exchange
        }).lean();
        if (!instrument) {
            return res.status(400).json({ error: "Instrument not found" });
        }
        const symboltoken = instrument.symboltoken;
        // For admin placing for client, we need the client's userId.
        // Encrypt search term to find user with encrypted client_key
        const encryptedClientCode = (0, encryption_1.encrypt)(clientcode);
        const targetUser = await User_1.default.findOne({ client_key: encryptedClientCode });
        if (!targetUser) {
            return res.status(404).json({ error: "User with this clientcode not found" });
        }
        // Pass the plain-text clientcode for token lookup
        const resp = await (0, OrderService_1.placeOrderForClient)(targetUser._id, clientcode, orderPayload);
        if (resp && resp.status === false) {
            logger_1.log.error("AngelOne order placement failed:", resp);
            return res.status(400).json({ ok: false, error: resp.message || "Broker order failed", resp });
        }
        const orderid = resp?.data?.orderid ||
            resp?.data?.data?.orderid ||
            resp?.data?.orderId ||
            `BROKER-${(0, uuid_1.v4)()}`;
        await Position_model_1.Position.create({
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
            tradeType: req.body.tradeType || "Manual",
            signalTime: new Date(),
            productType: req.body.producttype || "INTRADAY",
        });
        return res.json({ ok: true, resp, orderid });
    }
    catch (err) {
        logger_1.log.error("place order error", err.message || err);
        return res.status(500).json({ error: err.message || err });
    }
});
router.post("/place-all", auth_middleware_1.auth, auth_middleware_1.adminOnly, async (req, res) => {
    try {
        const qtyNum = Number(req.body.quantity);
        if (!qtyNum || Number.isNaN(qtyNum) || qtyNum <= 0) {
            return res.status(400).json({ error: "Valid quantity required" });
        }
        if (!req.body.tradingsymbol || !req.body.side) {
            return res.status(400).json({ error: "tradingsymbol and side required" });
        }
        const orderPayload = {
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
        const users = await User_1.default.find({
            status: "active",
            trading_status: "enabled",
            is_online: true,
            broker_connected: true
        }).lean();
        const instrument = await Instrument_1.default.findOne({
            tradingsymbol: orderPayload.tradingsymbol,
            exchange: orderPayload.exchange
        }).lean();
        const symboltoken = instrument?.symboltoken;
        const results = await Promise.all(users.map(async (user) => {
            let clientcode = user.client_key;
            if (!clientcode)
                return { userId: user._id, status: "skipped", reason: "missing client_key" };
            // Decrypt if it looks like an encrypted field (or always decrypt if consistently encrypted)
            try {
                clientcode = (0, encryption_1.decrypt)(clientcode);
            }
            catch (e) {
                logger_1.log.warn("Failed to decrypt clientcode for user:", user._id);
            }
            if (user.licence === "Demo") {
                const paperOrderId = `PAPER-${(0, uuid_1.v4)()}`;
                await Position_model_1.Position.create({
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
                    tradeType: req.body.tradeType || "Manual",
                    signalTime: new Date(),
                    productType: req.body.producttype || "INTRADAY",
                });
                return { userId: user._id, status: "paper", orderid: paperOrderId };
            }
            try {
                const resp = await (0, OrderService_1.placeOrderForClient)(user._id, clientcode, orderPayload);
                // 🔥 Verify if the broker actually accepted the order
                if (resp && (resp.status === false || resp.status === "error" || resp.errorcode)) {
                    const errMsg = resp.message || resp.error || "Broker rejected the order";
                    await BrokerResponse_1.BrokerResponse.create({
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
                const orderid = resp?.data?.orderid || resp?.data?.data?.orderid || `BROKER-${(0, uuid_1.v4)()}`;
                // 🕒 WAIT for Broker RMS to process (1.5 - 2 seconds)
                await new Promise(resolve => setTimeout(resolve, 2000));
                // 🔍 Fetch REAL Status from Broker
                let actualStatus = "SUCCESS";
                let actualMessage = "Order placed successfully";
                let finalBrokerData = resp;
                try {
                    const statusResp = await (0, OrderService_1.getOrderStatusForClient)(user._id, clientcode, orderid);
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
                        }
                        else if (bStatus === "CANCELLED") {
                            actualStatus = "REJECTED";
                            actualMessage = "Order Cancelled by Broker";
                        }
                        else if (bStatus === "COMPLETE") {
                            actualStatus = "SUCCESS";
                            actualMessage = "Order executed successfully";
                        }
                        else if (bStatus === "OPEN" || bStatus === "PENDING") {
                            actualStatus = "SUCCESS";
                            actualMessage = "Order is open/pending in broker terminal";
                        }
                    }
                    else {
                        actualStatus = "ERROR";
                        actualMessage = "Broker returned empty status response";
                    }
                }
                catch (statusErr) {
                    logger_1.log.warn(`Status check failed for ${orderid}:`, statusErr.message);
                    actualStatus = "ERROR";
                    actualMessage = "Sync failed: " + statusErr.message;
                }
                await Position_model_1.Position.create({
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
                    tradeType: req.body.tradeType || "Manual",
                    signalTime: new Date(),
                    productType: req.body.producttype || "INTRADAY",
                });
                // Log ACTUAL Response
                await BrokerResponse_1.BrokerResponse.create({
                    userId: user._id,
                    clientcode,
                    orderid,
                    tradingsymbol: orderPayload.tradingsymbol,
                    action: "BROADCAST_ORDER",
                    status: (actualStatus === "ERROR" ? "REJECTED" : actualStatus), // Map error to rejected for user clarity
                    message: actualMessage,
                    brokerError: finalBrokerData
                });
                return { userId: user._id, status: actualStatus === "REJECTED" ? "error" : "ok", orderid, message: actualMessage };
            }
            catch (err) {
                const errMsg = err.message || String(err);
                await BrokerResponse_1.BrokerResponse.create({
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
    }
    catch (err) {
        logger_1.log.error("place-all error", err.message || err);
        return res.status(500).json({ error: err.message || err });
    }
});
// 🔥 NEW: Place order for the logged-in user themselves
router.post("/place-user", auth_middleware_1.auth, async (req, res) => {
    const user = req.user;
    let clientcode = user.client_key;
    if (user.licence === "Live" && !clientcode) {
        return res.status(400).json({ error: "No broker client code assigned to your account" });
    }
    // Decrypt clientcode for token lookup
    if (clientcode) {
        try {
            clientcode = (0, encryption_1.decrypt)(clientcode);
        }
        catch (e) {
            logger_1.log.warn("Failed to decrypt clientcode for user:", user._id);
        }
    }
    try {
        const { symbol, optiontype, side, quantity, ordertype, producttype } = req.body;
        let { tradingsymbol, symboltoken } = req.body;
        // Auto-resolve ATM if tradingsymbol is missing but symbol/optiontype provided
        if (!tradingsymbol && symbol && optiontype) {
            const chain = await (0, NiftyOptionService_1.getOptionChain)(symbol.toUpperCase());
            const atmStrike = chain.atmStrike;
            const match = chain.options.find((o) => o.strike === atmStrike && o.optiontype === optiontype.toUpperCase());
            if (!match)
                return res.status(400).json({ error: `Could not find ATM ${optiontype} for ${symbol}` });
            tradingsymbol = match.tradingsymbol;
            symboltoken = match.symboltoken;
        }
        if (!tradingsymbol)
            return res.status(400).json({ error: "tradingsymbol required" });
        const orderPayload = {
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
            const paperOrderId = `PAPER-${(0, uuid_1.v4)()}`;
            await Position_model_1.Position.create({
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
        const resp = await (0, OrderService_1.placeOrderForClient)(user._id, clientcode, orderPayload);
        if (resp && resp.status === false) {
            return res.status(400).json({ ok: false, error: resp.message || "Broker order failed", resp });
        }
        const orderid = resp?.data?.orderid || resp?.data?.data?.orderid || `BROKER-${(0, uuid_1.v4)()}`;
        // 🕒 WAIT for Broker RMS
        await new Promise(resolve => setTimeout(resolve, 2000));
        // 🔍 Fetch REAL Status from Broker
        let actualStatus = "SUCCESS";
        let actualMessage = "Order placed successfully";
        let finalBrokerData = resp;
        try {
            const statusResp = await (0, OrderService_1.getOrderStatusForClient)(user._id, clientcode, orderid);
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
        }
        catch (statusErr) {
            logger_1.log.warn("Direct user status check failed:", statusErr.message);
            actualStatus = "ERROR";
            actualMessage = "Verification failed: " + statusErr.message;
        }
        await Position_model_1.Position.create({
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
            tradeType: req.body.tradeType || "Manual",
            signalTime: new Date(),
            productType: req.body.producttype || "INTRADAY",
        });
        // Log ACTUAL Response
        await BrokerResponse_1.BrokerResponse.create({
            userId: user._id,
            clientcode,
            orderid,
            tradingsymbol: orderPayload.tradingsymbol,
            action: "USER_ORDER",
            status: (actualStatus === "ERROR" ? "REJECTED" : actualStatus),
            message: actualMessage,
            brokerError: finalBrokerData
        });
        if (actualStatus === "REJECTED") {
            return res.status(400).json({ ok: false, error: actualMessage, orderid });
        }
        return res.json({ ok: true, resp, orderid });
    }
    catch (err) {
        return res.status(500).json({ error: err.message || err });
    }
});
router.get("/status/:clientcode/:orderId", auth_middleware_1.auth, async (req, res) => {
    try {
        const { clientcode, orderId } = req.params;
        const user = req.user;
        const userType = req.userType;
        // Security check: If user, must match clientcode
        if (userType === 'user' && user.client_key !== clientcode) {
            return res.status(403).json({ ok: false, message: "Unauthorized access to these orders" });
        }
        // Attempt to get live status from broker
        let brokerResp = null;
        try {
            brokerResp = await (0, OrderService_1.getOrderStatusForClient)(user._id, clientcode, orderId);
        }
        catch (e) {
            logger_1.log.warn(`Broker status check failed for ${orderId}:`, e.message);
        }
        // Sync with DB
        const order = await Position_model_1.Position.findOne({ orderid: orderId });
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
    }
    catch (err) {
        return res.status(500).json({ error: err.message || err });
    }
});
// --- MERGED FROM order.routes.ts ---
router.post("/save", auth_middleware_1.auth, auth_middleware_1.adminOnly, async (req, res) => {
    try {
        const { clientcode, orderid, tradingsymbol, exchange, side, quantity, price, symboltoken, autoSquareOffEnabled, autoSquareOffTime } = req.body;
        try {
            MarketStatusService_1.MarketStatusService.validateOrderRequest();
        }
        catch (err) {
            return res.status(400).json({ ok: false, message: err.message });
        }
        if (autoSquareOffEnabled && autoSquareOffTime) {
            const exitDate = new Date(autoSquareOffTime);
            if (isNaN(exitDate.getTime())) {
                throw new Error("Invalid auto square-off time");
            }
        }
        const newPosition = await Position_model_1.Position.create({
            clientcode,
            orderid,
            tradingsymbol,
            exchange,
            side,
            quantity,
            entryPrice: price || 0,
            symboltoken,
            stopLossPrice: req.body.stopLossPrice,
            targetPrice: req.body.targetPrice,
            status: "OPEN",
            autoSquareOffEnabled: autoSquareOffEnabled || false,
            autoSquareOffTime: autoSquareOffTime ? new Date(autoSquareOffTime) : undefined,
            autoSquareOffStatus: autoSquareOffEnabled ? "PENDING" : undefined,
            productType: req.body.producttype || "INTRADAY",
        });
        if (autoSquareOffEnabled && autoSquareOffTime) {
            const jobId = await AutoExitService_1.AutoExitService.scheduleExit(orderid, new Date(autoSquareOffTime));
            newPosition.autoSquareOffJobId = jobId;
            await newPosition.save();
        }
        res.json({ ok: true });
    }
    catch (err) {
        logger_1.log.error("Save order error:", err.message);
        res.status(500).json({ ok: false, message: "Save order failed", error: err.message });
    }
});
router.post("/close", async (req, res, next) => {
    if (req.headers['x-system-secret'] === 'INTERNAL_JOB_SECRET') {
        req.user = { role: 'admin', user_name: 'SYSTEM' };
        req.userType = 'admin';
        return next();
    }
    return (0, auth_middleware_1.auth)(req, res, next);
}, auth_middleware_1.adminOnly, async (req, res) => {
    try {
        const { clientcode, orderid } = req.body;
        try {
            if (req.headers['x-system-secret'] !== 'INTERNAL_JOB_SECRET') {
                MarketStatusService_1.MarketStatusService.validateOrderRequest();
            }
        }
        catch (err) {
            return res.status(400).json({ ok: false, message: err.message });
        }
        const position = await Position_model_1.Position.findOne({
            clientcode,
            orderid,
            status: "OPEN",
        });
        if (!position) {
            return res.status(404).json({ ok: false, message: "Open position not found" });
        }
        const exitSide = position.side === "BUY" ? "SELL" : "BUY";
        const orderInput = {
            exchange: position.exchange,
            tradingsymbol: position.tradingsymbol,
            side: exitSide,
            transactiontype: exitSide,
            quantity: position.quantity,
            ordertype: "MARKET",
            producttype: position.productType || "INTRADAY",
            symboltoken: position.symboltoken
        };
        const resp = await (0, OrderService_1.placeOrderForClient)(position.userId, clientcode, orderInput);
        if (resp && resp.status === false) {
            return res.status(400).json({ ok: false, message: resp.message || "Broker exit order failed" });
        }
        const orderid_resp = resp?.data?.orderid || resp?.data?.data?.orderid || "MANUAL";
        position.status = "CLOSED";
        position.exitOrderId = orderid_resp;
        position.exitQty = position.quantity;
        position.exitAt = new Date();
        await position.save();
        if (position.autoSquareOffEnabled && position.autoSquareOffJobId) {
            await AutoExitService_1.AutoExitService.cancelExit(position.orderid);
            position.autoSquareOffStatus = "CANCELLED";
            await position.save();
        }
        res.json({ ok: true, message: "Position squared off successfully", orderid: position.exitOrderId });
    }
    catch (err) {
        logger_1.log.error("Close order error:", err.message);
        res.status(500).json({ ok: false, message: "Failed to close position" });
    }
});
router.get("/active-positions/:clientcode", auth_middleware_1.auth, async (req, res) => {
    try {
        const { clientcode } = req.params;
        const user = req.user;
        const userType = req.userType;
        if (userType === 'user' && user.client_key !== clientcode) {
            return res.status(403).json({ ok: false, message: "Unauthorized access" });
        }
        const positions = await Position_model_1.Position.find({ clientcode, status: "OPEN" }).sort({ createdAt: -1 }).lean();
        if (positions.length === 0)
            return res.json({ ok: true, data: [] });
        const tokens = await AngelTokens_1.default.findOne({ clientcode });
        if (!tokens?.jwtToken)
            return res.status(401).json({ ok: false, message: "No active session" });
        const adapter = new AngelOneAdapter_1.AngelOneAdapter();
        const positionsWithLtp = await Promise.all(positions.map(async (p) => {
            try {
                let currentSymbolToken = p.symboltoken;
                if (!currentSymbolToken) {
                    const inst = await Instrument_1.default.findOne({ tradingsymbol: p.tradingsymbol, exchange: p.exchange });
                    currentSymbolToken = inst?.symboltoken;
                }
                if (currentSymbolToken) {
                    const ltpResp = await adapter.getLtp(tokens.jwtToken, p.exchange, p.tradingsymbol, currentSymbolToken);
                    const ltp = ltpResp?.data?.ltp || 0;
                    const pnl = p.side === "BUY" ? (ltp - p.entryPrice) * p.quantity : (p.entryPrice - ltp) * p.quantity;
                    return { ...p, ltp, pnl };
                }
                return { ...p, ltp: 0, pnl: 0 };
            }
            catch (err) {
                return { ...p, ltp: 0, pnl: 0 };
            }
        }));
        res.json({ ok: true, data: positionsWithLtp });
    }
    catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
});
router.get("/trade-history/:clientcode", auth_middleware_1.auth, async (req, res) => {
    try {
        const { clientcode } = req.params;
        const user = req.user;
        const userType = req.userType;
        if (userType === 'user' && user.client_key !== clientcode) {
            return res.status(403).json({ ok: false, message: "Unauthorized access" });
        }
        const history = await Position_model_1.Position.find({ clientcode, status: "CLOSED" }).sort({ exitAt: -1 }).lean();
        res.json({ ok: true, data: history });
    }
    catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
});
router.get("/broker-responses", auth_middleware_1.auth, async (req, res) => {
    try {
        const userId = req.id;
        // Get last 50 responses for this user
        const responses = await BrokerResponse_1.BrokerResponse.find({ userId })
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();
        res.json({ ok: true, data: responses });
    }
    catch (err) {
        res.status(500).json({ ok: false, message: err.message || String(err) });
    }
});
router.get("/history-all", auth_middleware_1.auth, auth_middleware_1.adminOnly, order_controller_1.getGlobalTradeHistory);
router.get("/unique-symbols", auth_middleware_1.auth, auth_middleware_1.adminOnly, order_controller_1.getUniqueSymbols);
router.get("/export-all", auth_middleware_1.auth, auth_middleware_1.adminOnly, order_controller_1.exportGlobalTradeHistory);
// 🔥 NEW: Update Auto Exit Time for an existing position
router.post("/update-auto-exit", auth_middleware_1.auth, auth_middleware_1.adminOnly, async (req, res) => {
    try {
        const { orderid, autoSquareOffTime, autoSquareOffEnabled } = req.body;
        logger_1.log.info(`[AutoExitRoute] Request for ${orderid}:`, { autoSquareOffTime, autoSquareOffEnabled });
        if (!orderid)
            return res.status(400).json({ ok: false, message: "orderid required" });
        const position = await Position_model_1.Position.findOne({ orderid });
        if (!position) {
            logger_1.log.warn(`[AutoExitRoute] Position ${orderid} not found`);
            return res.status(404).json({ ok: false, message: "Position not found" });
        }
        // 1. Cancel existing job if any
        try {
            if (position.autoSquareOffJobId) {
                logger_1.log.debug(`[AutoExitRoute] Cancelling previous job ${position.autoSquareOffJobId}`);
                await AutoExitService_1.AutoExitService.cancelExit(orderid);
            }
        }
        catch (cancelErr) {
            logger_1.log.warn(`[AutoExitRoute] Cancel job failed for ${orderid} (ignoring):`, cancelErr);
        }
        // 2. Schedule new job if enabled
        let jobId = undefined;
        let finalExitDate = undefined;
        if (autoSquareOffEnabled && autoSquareOffTime) {
            const istDate = moment_timezone_1.default.tz(autoSquareOffTime, "Asia/Kolkata");
            if (!istDate.isValid()) {
                throw new Error("Invalid date format provided");
            }
            finalExitDate = istDate.toDate();
            logger_1.log.info(`[AutoExitRoute] Scheduling new job at ${istDate.format()} for ${orderid}`);
            jobId = await AutoExitService_1.AutoExitService.scheduleExit(orderid, autoSquareOffTime);
        }
        // 3. Update DB
        position.autoSquareOffEnabled = autoSquareOffEnabled;
        position.autoSquareOffTime = finalExitDate;
        position.autoSquareOffJobId = jobId;
        position.autoSquareOffStatus = autoSquareOffEnabled ? "PENDING" : "CANCELLED";
        await position.save();
        logger_1.log.info(`[AutoExitRoute] Successfully updated DB for ${orderid}`);
        res.json({ ok: true, message: "Auto exit updated successfully" });
    }
    catch (err) {
        logger_1.log.error("[AutoExitRoute] Error:", err.message);
        res.status(500).json({ ok: false, message: err.message || "Internal server error" });
    }
});
exports.default = router;
