"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const orderServices_1 = require("../services/orderServices");
const router = (0, express_1.Router)();
router.post("/order/place", async (req, res) => {
    try {
        const { instrument_key, lots, side, type, price } = req.body;
        if (!instrument_key)
            return res.status(400).json({ error: "instrument_key is required" });
        const response = await (0, orderServices_1.placeOptionOrder)(instrument_key, Number(lots), side, type, price ? Number(price) : 0);
        res.json(response);
    }
    catch (error) {
        console.error("ORDER ROUTE ERROR:", error);
        res.status(400).json({ error: error.message });
    }
});
exports.default = router;
