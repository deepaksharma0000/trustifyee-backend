import { Router } from "express";
import { auth, adminOnly } from "../middleware/auth.middleware";
import { startRun, stopRun, getStatus, getRuns, getTrades, getSummary } from "../services/algoEngine";

const router = Router();

router.get("/status", auth, adminOnly, async (_req, res) => {
  const run = await getStatus();
  return res.json({ ok: true, run });
});

router.get("/runs", auth, adminOnly, async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  const runs = await getRuns(limit);
  return res.json({ ok: true, runs });
});

router.get("/trades/:runId", auth, adminOnly, async (req, res) => {
  const { runId } = req.params;
  const limit = req.query.limit ? Number(req.query.limit) : 200;
  const trades = await getTrades(runId, limit);
  return res.json({ ok: true, trades });
});

router.get("/summary", auth, adminOnly, async (req, res) => {
  const date = req.query.date ? String(req.query.date) : undefined;
  const summary = await getSummary(date);
  return res.json({ ok: true, summary });
});

router.post("/start", auth, adminOnly, async (req, res) => {
  const { symbol, expiry, strategy, optionSide } = req.body;
  if (!symbol || !expiry || !strategy) {
    return res.status(400).json({ error: "symbol, expiry, strategy required" });
  }

  const createdBy = (req as any).id;
  const result = await startRun({
    symbol,
    expiry: new Date(expiry),
    strategy,
    optionSide,
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
