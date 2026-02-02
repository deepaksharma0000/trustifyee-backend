"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.closePosition = exports.getOpenPositions = void 0;
const Position_model_1 = require("../models/Position.model");
const getOpenPositions = async (req, res) => {
    try {
        const { clientcode } = req.params;
        const positions = await Position_model_1.Position.find({
            clientcode,
            status: { $in: ["OPEN", "COMPLETE"] },
        }).sort({ createdAt: -1 });
        res.json({
            ok: true,
            data: positions,
        });
    }
    catch (err) {
        res.status(500).json({
            ok: false,
            message: "Failed to fetch open positions",
        });
    }
};
exports.getOpenPositions = getOpenPositions;
const closePosition = async (req, res) => {
    const { orderid } = req.body;
    await Position_model_1.Position.findOneAndUpdate({ orderid }, { status: "CLOSED" });
    res.json({ ok: true });
};
exports.closePosition = closePosition;
