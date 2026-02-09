import { Router } from "express";
import { auth, adminOnly } from "../middleware/auth.middleware";
import { startRun, stopRun, getStatus, getRuns, getTrades, getSummary } from "../services/algoEngineV2";
import { getAllStrategies, validateStrategy } from "../services/StrategyEngine";
import { AlgoTrade } from "../models/AlgoTrade";

const router = Router();

function toCsv(rows: any[]) {
  if (!rows.length) return "";
  const columns = Array.from(
    new Set(rows.flatMap((r) => Object.keys(r)))
  );

  const escapeCsv = (value: any) => {
    if (value === null || value === undefined) return "";
    const str = value instanceof Date ? value.toISOString() : String(value);
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const header = columns.join(",");
  const lines = rows.map((row) =>
    columns.map((c) => escapeCsv((row as any)[c])).join(",")
  );
  return [header, ...lines].join("\n");
}

router.get("/status", auth, adminOnly, async (_req, res) => {
  const run = await getStatus();
  return res.json({ ok: true, run });
});

// 🔥 NEW: Get all available strategies
router.get("/strategies", auth, async (_req, res) => {
  try {
    const strategies = getAllStrategies();
    return res.json({ ok: true, strategies });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 🔥 NEW: Validate strategy
router.post("/strategies/validate", auth, adminOnly, async (req, res) => {
  try {
    const { strategyName } = req.body;
    if (!strategyName) {
      return res.status(400).json({ ok: false, error: "strategyName required" });
    }
    const validation = validateStrategy(strategyName);
    return res.json({ ok: true, ...validation });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/runs", auth, adminOnly, async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  const runs = await getRuns(limit);
  return res.json({ ok: true, runs });
});

router.get("/runs/export", auth, adminOnly, async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 500;
  const runs = await getRuns(limit);
  const csv = toCsv(runs);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=\"algo-runs.csv\"");
  return res.send(csv);
});

router.get("/trades/:runId", auth, adminOnly, async (req, res) => {
  const { runId } = req.params;
  const limit = req.query.limit ? Number(req.query.limit) : 200;
  const trades = await getTrades(runId, limit);
  return res.json({ ok: true, trades });
});

router.get("/trades/export", auth, adminOnly, async (req, res) => {
  const runId = req.query.runId ? String(req.query.runId) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 1000;

  const trades = runId
    ? await getTrades(runId, limit)
    : await AlgoTrade.find().sort({ createdAt: -1 }).limit(limit).lean();

  const csv = toCsv(trades);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=\"algo-trades.csv\"");
  return res.send(csv);
});

router.get("/summary", auth, adminOnly, async (req, res) => {
  const date = req.query.date ? String(req.query.date) : undefined;
  const summary = await getSummary(date);
  return res.json({ ok: true, summary });
});

router.post("/start", auth, adminOnly, async (req, res) => {
  const { symbol, expiry, strategy } = req.body;
  if (!symbol || !expiry || !strategy) {
    return res.status(400).json({ error: "symbol, expiry, strategy required" });
  }

  const createdBy = (req as any).id;
  const result = await startRun({
    symbol,
    expiry: new Date(expiry),
    strategy,
    createdBy,
  });

  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

router.post("/stop", auth, adminOnly, async (req, res) => {
  const { runId, reason } = req.body;
  if (!runId) {
    return res.status(400).json({ error: "runId required" });
  }
  const result = await stopRun(runId, reason || "Stopped");
  return res.json(result);
});

export default router;
