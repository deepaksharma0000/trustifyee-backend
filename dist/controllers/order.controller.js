"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.closeOrder = exports.savePlacedOrder = exports.getOrderStatus = void 0;
const Position_model_1 = require("../models/Position.model");
// import { checkAngelOrderStatus } from "../services/angel.service";
const angel_service_1 = require("../services/angel.service");
const getOrderStatus = async (req, res) => {
    const { orderid } = req.params;
    const order = await Position_model_1.Position.findOne({ orderid });
    if (!order)
        return res.json({ ok: false });
    return res.json({
        ok: true,
        status: order.status, // PENDING | COMPLETE | REJECTED
    });
};
exports.getOrderStatus = getOrderStatus;
const savePlacedOrder = async (req, res) => {
    try {
        const { clientcode, orderid, tradingsymbol, exchange, side, quantity, price, } = req.body;
        await Position_model_1.Position.create({
            clientcode,
            orderid,
            tradingsymbol,
            exchange,
            side,
            quantity,
            entryPrice: price,
            status: "PENDING",
        });
        res.json({ ok: true });
    }
    catch (err) {
        res.status(500).json({ ok: false, message: "Save order failed" });
    }
};
exports.savePlacedOrder = savePlacedOrder;
const closeOrder = async (req, res) => {
    try {
        const { clientcode, orderid } = req.body;
        const position = await Position_model_1.Position.findOne({
            clientcode,
            orderid,
            status: "OPEN",
        });
        if (!position) {
            return res.status(404).json({
                ok: false,
                message: "Open position not found",
            });
        }
        const exitSide = position.side === "BUY" ? "SELL" : "BUY";
        // 🔥 EXIT = NEW ORDER PLACE
        const angelResp = await (0, angel_service_1.placeAngelOrder)({
            clientcode,
            tradingsymbol: position.tradingsymbol,
            exchange: position.exchange,
            side: exitSide,
            quantity: position.quantity,
            ordertype: "MARKET",
        });
        if (!angelResp?.ok) {
            return res.status(400).json({
                ok: false,
                message: "Angel exit order failed",
            });
        }
        // ✅ DB UPDATE
        position.status = "CLOSED";
        position.exitOrderId = angelResp.resp.data.orderid;
        position.exitAt = new Date();
        await position.save();
        res.json({
            ok: true,
            message: "Position squared off successfully",
        });
    }
    catch (err) {
        console.error("Close order error:", err);
        res.status(500).json({
            ok: false,
            message: "Failed to close position",
        });
    }
};
exports.closeOrder = closeOrder;
