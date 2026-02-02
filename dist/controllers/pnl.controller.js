"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLivePnL = void 0;
const Position_model_1 = require("../models/Position.model");
const market_service_1 = require("../services/market.service");
const getLivePnL = async (req, res) => {
    try {
        const { clientcode } = req.params;
        const positions = await Position_model_1.Position.find({
            clientcode,
            status: "OPEN",
        });
        const result = [];
        for (const pos of positions) {
            // 🔥 current market price
            const ltp = await (0, market_service_1.getLTP)(pos.tradingsymbol);
            let pnl = 0;
            if (pos.side === "BUY") {
                pnl = (ltp - pos.entryPrice) * pos.quantity;
            }
            else {
                pnl = (pos.entryPrice - ltp) * pos.quantity;
            }
            result.push({
                orderid: pos.orderid,
                tradingsymbol: pos.tradingsymbol,
                side: pos.side,
                quantity: pos.quantity,
                entryPrice: pos.entryPrice,
                ltp,
                pnl: Number(pnl.toFixed(2)),
            });
        }
        res.json({
            ok: true,
            data: result,
        });
    }
    catch (err) {
        res.status(500).json({
            ok: false,
            message: "Live PnL fetch failed",
        });
    }
};
exports.getLivePnL = getLivePnL;
