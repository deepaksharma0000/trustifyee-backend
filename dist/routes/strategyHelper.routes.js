"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/strategyHelper.routes.ts
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const StrategyEngine_1 = require("../services/StrategyEngine");
const StrategyController_1 = require("../controllers/StrategyController");
const Strategy_1 = __importDefault(require("../models/Strategy"));
const logger_1 = require("../utils/logger");
const router = (0, express_1.Router)();
/**
 * Get all available strategies
 */
router.get("/list", auth_middleware_1.auth, async (_req, res) => {
    try {
        const staticStrategies = (0, StrategyEngine_1.getAllStrategies)();
        const dbStrategies = await Strategy_1.default.find().sort({ created_at: -1 });
        const combined = [
            ...staticStrategies.map(s => ({ name: s.name, type: 'static' })),
            ...dbStrategies.map(s => ({ name: s.strategy_name, type: 'db' }))
        ];
        // Remove duplicates by name
        const unique = combined.filter((v, i, a) => a.findIndex(t => t.name === v.name) === i);
        return res.json({ ok: true, strategies: unique });
    }
    catch (err) {
        logger_1.log.error("Get strategies error:", err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});
/**
 * Add a new strategy (from DB controller)
 */
router.post("/add-strategies", auth_middleware_1.auth, StrategyController_1.addStrategy);
/**
 * Get all strategies from DB
 */
router.get("/all", auth_middleware_1.auth, StrategyController_1.getStrategies);
/**
 * Auto-select strikes based on strategy
 * This endpoint helps admin by suggesting strikes based on strategy logic
 */
router.post("/auto-select", auth_middleware_1.auth, async (req, res) => {
    try {
        const { symbol, expiry, strategy } = req.body;
        if (!symbol || !expiry || !strategy) {
            return res.status(400).json({
                ok: false,
                error: "symbol, expiry, and strategy are required",
            });
        }
        logger_1.log.info(`Auto-selecting strikes for ${strategy} on ${symbol} ${expiry}`);
        // Resolve strategy legs
        const legs = await (0, StrategyEngine_1.resolveStrategyLegs)({
            symbol,
            expiry: new Date(expiry),
            strategyName: strategy,
            lotSize: 1,
        });
        // Transform to frontend-friendly format
        const selectedOptions = legs.map((leg) => ({
            symboltoken: leg.symboltoken,
            tradingsymbol: leg.tradingsymbol,
            expiry: leg.expiry,
            optiontype: leg.optionType,
            strike: leg.strike,
            side: leg.side,
            quantity: leg.quantity,
        }));
        logger_1.log.info(`✅ Auto-selected ${selectedOptions.length} options for ${strategy}`);
        return res.json({
            ok: true,
            strategy,
            selectedOptions,
            message: `Auto-selected ${selectedOptions.length} options based on ${strategy} strategy`,
        });
    }
    catch (err) {
        logger_1.log.error("Auto-select error:", err.message);
        return res.status(500).json({
            ok: false,
            error: err.message || "Failed to auto-select strikes",
        });
    }
});
exports.default = router;
