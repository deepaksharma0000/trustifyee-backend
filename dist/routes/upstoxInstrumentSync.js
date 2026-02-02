"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/upstoxInstrumentSync.ts
const express_1 = __importDefault(require("express"));
const upstoxInstrumentService_1 = require("../services/upstoxInstrumentService");
const logger_1 = require("../utils/logger");
const router = express_1.default.Router();
const instrumentService = new upstoxInstrumentService_1.UpstoxInstrumentService();
/**
 * POST /api/upstox/instruments/sync/bod
 * Sync BOD instruments from Upstox
 */
router.post("/sync/bod", async (req, res) => {
    try {
        const { marketType = 'complete' } = req.body;
        const result = await instrumentService.syncBodInstruments(marketType);
        return res.json({
            ok: true,
            ...result
        });
    }
    catch (error) {
        logger_1.log.error("BOD sync route error:", error);
        return res.status(500).json({
            ok: false,
            error: error.message || "Sync failed"
        });
    }
});
/**
 * GET /api/upstox/instruments/search
 * Search instruments
 */
router.get("/search", async (req, res) => {
    try {
        const { q, exchange, segment, instrument_type, option_type, expiry, limit = "50", skip = "0" } = req.query;
        const filters = {};
        if (exchange)
            filters.exchange = exchange;
        if (segment)
            filters.segment = segment;
        if (instrument_type)
            filters.instrument_type = instrument_type;
        if (option_type)
            filters.option_type = option_type;
        if (expiry)
            filters.expiry_date = expiry;
        filters.limit = parseInt(limit);
        filters.skip = parseInt(skip);
        if (!q) {
            return res.status(400).json({
                ok: false,
                error: "Search term (q) is required"
            });
        }
        const instruments = await instrumentService.searchInstruments(q, filters);
        return res.json({
            ok: true,
            count: instruments.length,
            data: instruments
        });
    }
    catch (error) {
        logger_1.log.error("Search instruments route error:", error);
        return res.status(500).json({
            ok: false,
            error: error.message || "Search failed"
        });
    }
});
/**
 * GET /api/upstox/instruments/option-chain/:underlying
 * Get option chain for an underlying
 */
router.get("/option-chain/:underlying", async (req, res) => {
    try {
        const { underlying } = req.params;
        const { expiry } = req.query;
        const chain = await instrumentService.getOptionChain(underlying, expiry);
        return res.json({
            ok: true,
            underlying,
            chain
        });
    }
    catch (error) {
        logger_1.log.error("Option chain route error:", error);
        return res.status(500).json({
            ok: false,
            error: error.message || "Failed to fetch option chain"
        });
    }
});
/**
 * GET /api/upstox/instruments/:instrumentKey
 * Get instrument by instrument_key
 */
router.get("/:instrumentKey", async (req, res) => {
    try {
        const { instrumentKey } = req.params;
        const instrument = await instrumentService.getInstrumentByKey(instrumentKey);
        return res.json({
            ok: true,
            data: instrument
        });
    }
    catch (error) {
        logger_1.log.error("Get instrument route error:", error);
        return res.status(500).json({
            ok: false,
            error: error.message || "Instrument not found"
        });
    }
});
exports.default = router;
