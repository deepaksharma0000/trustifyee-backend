"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/upstoxAlgoOrderRoutes.ts
const express_1 = require("express");
const orderServices_1 = require("../services/orderServices");
const router = (0, express_1.Router)();
/**
 * POST /api/upstox/option/algo-order
 * Body:
 * {
 *   "underlyingSymbol": "NIFTY",
 *   "ltp": 24210,
 *   "side": "BUY",
 *   "optionSide": "CE",
 *   "type": "MARKET",
 *   "lots": 1,
 *   "strikesAway": 0,
 *   "expiryMode": "NEAREST"
 * }
 */
router.post("/option/algo-order", async (req, res) => {
    try {
        const { underlyingSymbol, ltp, side, optionSide, type, lots, strikesAway, expiryMode, price, } = req.body;
        if (!underlyingSymbol || typeof underlyingSymbol !== "string") {
            return res
                .status(400)
                .json({ error: "underlyingSymbol is required (e.g. NIFTY)" });
        }
        if (!ltp || typeof ltp !== "number") {
            return res
                .status(400)
                .json({ error: "ltp (underlying price) is required as number" });
        }
        const resp = await (0, orderServices_1.placeAlgoOptionOrder)({
            underlyingSymbol: underlyingSymbol.trim().toUpperCase(),
            ltp,
            side,
            optionSide,
            type,
            lots: Number(lots),
            strikesAway: strikesAway ? Number(strikesAway) : 0,
            expiryMode: expiryMode || "NEAREST",
            price: price ? Number(price) : undefined,
        });
        res.json(resp);
    }
    catch (err) {
        console.error("ALGO ORDER ERROR:", err);
        res.status(400).json({ error: err.message || err });
    }
});
exports.default = router;
