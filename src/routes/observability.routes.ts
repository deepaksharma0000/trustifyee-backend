// src/routes/observability.routes.ts
import { Router } from "express";
import { observabilityStack } from "../services/ObservabilityStack";
import { shadowExecutionService } from "../services/ShadowExecutionService";

const router = Router();

/**
 * Scrape metrics endpoint in Prometheus format
 */
router.get("/prometheus", (req, res) => {
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(observabilityStack.scrapeMetrics());
});

/**
 * Expose metrics in standard JSON format
 */
router.get("/metrics", (req, res) => {
  res.json({
    status: "success",
    metrics: observabilityStack.getSnapshot(),
  });
});

/**
 * Retrieve active warning and critical alerts
 */
router.get("/alerts", (req, res) => {
  res.json({
    status: "success",
    alerts: observabilityStack.getAlerts(),
  });
});

/**
 * Retrieve parallel shadow execution match logs
 */
router.get("/shadow-log", (req, res) => {
  res.json({
    status: "success",
    shadowLog: shadowExecutionService.getShadowLog(),
  });
});

/**
 * Clear alert buffer
 */
router.post("/clear-alerts", (req, res) => {
  observabilityStack.clearAlerts();
  res.json({ status: "success", message: "Alert buffer cleared successfully" });
});

/**
 * Retrieve current startup diagnostics status, drift analytics, and unstable dependency heatmap
 */
router.get("/startup/status", (req, res) => {
  try {
    const { StartupDiagnostics } = require("../utils/startupDiagnostics");
    const drift = StartupDiagnostics.calculateDriftAnalytics();
    const heatmap = StartupDiagnostics.generateHeatmaps();
    res.json({
      status: "success",
      data: {
        correlationId: StartupDiagnostics.correlationId,
        state: StartupDiagnostics.state,
        safeBootMode: StartupDiagnostics.isSafeBootMode(),
        driftAnalytics: drift,
        failureHeatmap: heatmap,
        eventsCount: StartupDiagnostics.events.length,
      }
    });
  } catch (err: any) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

/**
 * Replay the full boot sequence chronologically for a specific startup correlation ID
 */
router.get("/startup/replay/:correlationId", async (req, res) => {
  try {
    const { correlationId } = req.params;
    const { BootSequenceReplayEngine } = require("../utils/startupDiagnostics");
    if (!correlationId) {
      return res.status(400).json({ status: "error", message: "correlationId parameter is required" });
    }
    const replay = await BootSequenceReplayEngine.replayFromStream(correlationId);
    if (!replay.success) {
      return res.status(404).json({ status: "error", message: replay.message });
    }
    res.json({
      status: "success",
      data: replay,
    });
  } catch (err: any) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;
