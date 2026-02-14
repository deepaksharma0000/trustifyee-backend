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
const uuid_1 = require("uuid");
const router = express_1.default.Router();
router.post("/place", auth_middleware_1.auth, auth_middleware_1.adminOnly, async (req, res) => {
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
        logger_1.log.debug("Incoming place order:", { clientcode, orderPayload });
        // Fetch instrument for symboltoken if not provided or just to be safe for Position record
        const instrument = await Instrument_1.default.findOne({
            tradingsymbol: orderPayload.tradingsymbol,
            exchange: "NFO"
        }).lean();
        if (!instrument) {
            return res.status(400).json({ error: "Instrument not found" });
        }
        const symboltoken = instrument.symboltoken;
        const resp = await (0, OrderService_1.placeOrderForClient)(clientcode, orderPayload);
        if (resp && resp.status === false) {
            logger_1.log.error("AngelOne order placement failed:", resp);
            return res.status(400).json({ ok: false, error: resp.message || "Broker order failed", resp });
        }
        // Extract order ID
        const orderid = resp?.data?.orderid ||
            resp?.data?.uniqueorderid ||
            resp?.data?.data?.orderid ||
            resp?.data?.orderId ||
            `BROKER-${(0, uuid_1.v4)()}`;
        // Create Position Record
        await Position_model_1.Position.create({
            clientcode,
            orderid,
            tradingsymbol: orderPayload.tradingsymbol,
            exchange: orderPayload.exchange,
            side: orderPayload.side,
            quantity: orderPayload.quantity, // We store LOT quantity here currently based on schema usage in getActivePositions
            entryPrice: Number(orderPayload.price ?? 0),
            symboltoken,
            stopLossPrice: req.body.stopLossPrice ? Number(req.body.stopLossPrice) : undefined,
            targetPrice: req.body.targetPrice ? Number(req.body.targetPrice) : undefined,
            strategy: req.body.strategy || "Manual",
            status: "OPEN",
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
        }).lean();
        const instrument = await Instrument_1.default.findOne({
            tradingsymbol: orderPayload.tradingsymbol,
            exchange: "NFO"
        }).lean();
        const symboltoken = instrument?.symboltoken;
        const results = await Promise.all(users.map(async (user) => {
            const clientcode = user.client_key;
            if (!clientcode) {
                return { userId: user._id, status: "skipped", reason: "missing client_key" };
            }
            // Demo users: paper trade only
            if (user.licence === "Demo") {
                const paperOrderId = `PAPER-${(0, uuid_1.v4)()}`;
                await Position_model_1.Position.create({
                    clientcode,
                    orderid: paperOrderId,
                    tradingsymbol: orderPayload.tradingsymbol,
                    exchange: orderPayload.exchange,
                    side: orderPayload.side,
                    quantity: orderPayload.quantity,
                    entryPrice: Number(orderPayload.price ?? 0),
                    symboltoken,
                    stopLossPrice: req.body.stopLossPrice ? Number(req.body.stopLossPrice) : undefined,
                    targetPrice: req.body.targetPrice ? Number(req.body.targetPrice) : undefined,
                    strategy: req.body.strategy || "Manual",
                    status: "OPEN",
                });
                return { userId: user._id, status: "paper", orderid: paperOrderId };
            }
            try {
                const resp = await (0, OrderService_1.placeOrderForClient)(clientcode, orderPayload);
                const orderid = resp?.data?.orderid ||
                    resp?.data?.data?.orderid ||
                    resp?.data?.orderId ||
                    resp?.data?.data?.orderId ||
                    `BROKER-${(0, uuid_1.v4)()}`;
                await Position_model_1.Position.create({
                    clientcode,
                    orderid,
                    tradingsymbol: orderPayload.tradingsymbol,
                    exchange: orderPayload.exchange,
                    side: orderPayload.side,
                    quantity: orderPayload.quantity,
                    entryPrice: Number(orderPayload.price ?? 0),
                    symboltoken,
                    stopLossPrice: req.body.stopLossPrice ? Number(req.body.stopLossPrice) : undefined,
                    targetPrice: req.body.targetPrice ? Number(req.body.targetPrice) : undefined,
                    strategy: req.body.strategy || "Manual",
                    status: "OPEN",
                });
                return { userId: user._id, status: "ok", orderid };
            }
            catch (err) {
                return { userId: user._id, status: "error", error: err.message || String(err) };
            }
        }));
        return res.json({
            ok: true,
            totalUsers: users.length,
            results
        });
    }
    catch (err) {
        logger_1.log.error("place-all error", err.message || err);
        return res.status(500).json({ error: err.message || err });
    }
});
router.get("/status/:clientcode/:orderId", async (req, res) => {
    try {
        const { clientcode, orderId } = req.params;
        const resp = await (0, OrderService_1.getOrderStatusForClient)(clientcode, orderId);
        return res.json({ ok: true, resp });
    }
    catch (err) {
        return res.status(500).json({ error: err.message || err });
    }
});
exports.default = router;
