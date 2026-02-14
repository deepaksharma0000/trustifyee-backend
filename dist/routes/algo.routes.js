"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/auth.middleware");
const algoEngineV2_1 = require("../services/algoEngineV2");
const StrategyEngine_1 = require("../services/StrategyEngine");
const AlgoTrade_1 = require("../models/AlgoTrade");
const router = (0, express_1.Router)();
function toCsv(rows) {
    if (!rows.length)
        return "";
    const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
    const escapeCsv = (value) => {
        if (value === null || value === undefined)
            return "";
        const str = value instanceof Date ? value.toISOString() : String(value);
        if (/[",\n]/.test(str)) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };
    const header = columns.join(",");
    const lines = rows.map((row) => columns.map((c) => escapeCsv(row[c])).join(","));
    return [header, ...lines].join("\n");
}
router.get("/status", auth_middleware_1.auth, auth_middleware_1.adminOnly, async (_req, res) => {
    const run = await (0, algoEngineV2_1.getStatus)();
    return res.json({ ok: true, run });
});
// 🔥 NEW: Get all available strategies
router.get("/strategies", auth_middleware_1.auth, async (_req, res) => {
    try {
        const strategies = (0, StrategyEngine_1.getAllStrategies)();
        return res.json({ ok: true, strategies });
    }
    catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});
// 🔥 NEW: Validate strategy
router.post("/strategies/validate", auth_middleware_1.auth, auth_middleware_1.adminOnly, async (req, res) => {
    try {
        const { strategyName } = req.body;
        if (!strategyName) {
            return res.status(400).json({ ok: false, error: "strategyName required" });
        }
        const validation = (0, StrategyEngine_1.validateStrategy)(strategyName);
        return res.json({ ok: true, ...validation });
    }
    catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});
router.get("/runs", auth_middleware_1.auth, auth_middleware_1.adminOnly, async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const runs = await (0, algoEngineV2_1.getRuns)(limit);
    return res.json({ ok: true, runs });
});
router.get("/runs/export", auth_middleware_1.auth, auth_middleware_1.adminOnly, async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 500;
    const runs = await (0, algoEngineV2_1.getRuns)(limit);
    const csv = toCsv(runs);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=\"algo-runs.csv\"");
    return res.send(csv);
});
router.get("/trades/:runId", auth_middleware_1.auth, auth_middleware_1.adminOnly, async (req, res) => {
    const { runId } = req.params;
    const limit = req.query.limit ? Number(req.query.limit) : 200;
    const trades = await (0, algoEngineV2_1.getTrades)(runId, limit);
    return res.json({ ok: true, trades });
});
router.get("/my-trades/:runId", auth_middleware_1.auth, async (req, res) => {
    const { runId } = req.params;
    const userId = req.id;
    const limit = req.query.limit ? Number(req.query.limit) : 200;
    const trades = await (0, algoEngineV2_1.getTrades)(runId, limit, userId);
    return res.json({ ok: true, trades });
});
router.get("/trades/export", auth_middleware_1.auth, auth_middleware_1.adminOnly, async (req, res) => {
    const runId = req.query.runId ? String(req.query.runId) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 1000;
    const trades = runId
        ? await (0, algoEngineV2_1.getTrades)(runId, limit)
        : await AlgoTrade_1.AlgoTrade.find().sort({ createdAt: -1 }).limit(limit).lean();
    const csv = toCsv(trades);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=\"algo-trades.csv\"");
    return res.send(csv);
});
router.get("/summary", auth_middleware_1.auth, auth_middleware_1.adminOnly, async (req, res) => {
    const date = req.query.date ? String(req.query.date) : undefined;
    const summary = await (0, algoEngineV2_1.getSummary)(date);
    return res.json({ ok: true, summary });
});
router.post("/start", auth_middleware_1.auth, auth_middleware_1.adminOnly, async (req, res) => {
    const { symbol, expiry, strategy } = req.body;
    if (!symbol || !expiry || !strategy) {
        return res.status(400).json({ error: "symbol, expiry, strategy required" });
    }
    const createdBy = req.id;
    const result = await (0, algoEngineV2_1.startRun)({
        symbol,
        expiry: new Date(expiry),
        strategy,
        createdBy,
    });
    if (!result.ok)
        return res.status(400).json(result);
    return res.json(result);
});
router.post("/stop", auth_middleware_1.auth, auth_middleware_1.adminOnly, async (req, res) => {
    const { runId, reason } = req.body;
    if (!runId) {
        return res.status(400).json({ error: "runId required" });
    }
    const result = await (0, algoEngineV2_1.stopRun)(runId, reason || "Stopped");
    return res.json(result);
});
exports.default = router;
