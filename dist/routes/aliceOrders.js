"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/aliceOrders.ts
const express_1 = __importDefault(require("express"));
const AliceOrderService_1 = require("../services/AliceOrderService");
const logger_1 = require("../utils/logger");
const auth_middleware_1 = require("../middleware/auth.middleware");
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
            exchange: (req.body.exchange || "").toString().toUpperCase(),
            tradingsymbol: req.body.tradingsymbol,
            side: req.body.side,
            transactiontype: req.body.transactiontype,
            quantity: qtyNum,
            ordertype: req.body.ordertype,
            price: req.body.price ?? 0,
            producttype: req.body.producttype,
            duration: req.body.duration,
            symboltoken: req.body.symboltoken,
            triggerPrice: req.body.triggerPrice
        };
        logger_1.log.debug("Alice Incoming place order:", { clientcode, orderPayload });
        const resp = await (0, AliceOrderService_1.placeAliceOrderForClient)(clientcode, orderPayload);
        return res.json({ ok: true, resp });
    }
    catch (err) {
        logger_1.log.error("Alice place order error", err.message || err);
        return res.status(500).json({ error: err.message || err });
    }
});
router.get("/status/:clientcode/:orderId", async (req, res) => {
    try {
        const { clientcode, orderId } = req.params;
        const resp = await (0, AliceOrderService_1.getAliceOrderStatusForClient)(clientcode, orderId);
        return res.json({ ok: true, resp });
    }
    catch (err) {
        return res.status(500).json({ error: err.message || err });
    }
});
exports.default = router;
