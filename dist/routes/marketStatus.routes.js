"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const MarketStatusService_1 = require("../services/MarketStatusService");
const router = (0, express_1.Router)();
router.get("/status", (req, res) => {
    const status = MarketStatusService_1.MarketStatusService.getMarketStatus();
    res.json({
        ok: true,
        data: status
    });
});
exports.default = router;
