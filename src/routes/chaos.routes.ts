// src/routes/chaos.routes.ts
import { Router } from "express";
import { chaosTestingFramework } from "../services/ChaosTestingFramework";
import log from "../utils/logger";

const router = Router();

/**
 * Trigger WebSocket Disconnect Storm Drill
 */
router.post("/websocket-storm", async (req, res) => {
  try {
    log.warn("[ADMIN_CHAOS] Triggering WebSocket Disconnect Storm Drill");
    const diag = await chaosTestingFramework.executeWebsocketDisconnectStorm();
    res.json({ status: "success", diagnostics: diag });
  } catch (err: any) {
    res.status(500).json({ status: "failed", error: err.message });
  }
});

/**
 * Trigger NTP Clock Drift Anomaly Drill
 */
router.post("/clock-drift", async (req, res) => {
  try {
    log.warn("[ADMIN_CHAOS] Triggering NTP Clock Drift Anomaly Drill");
    const diag = await chaosTestingFramework.executeClockDriftAnomaly();
    res.json({ status: "success", diagnostics: diag });
  } catch (err: any) {
    res.status(500).json({ status: "failed", error: err.message });
  }
});

/**
 * Trigger Strategy Sandbox Crash Drill
 */
router.post("/sandbox-crash", async (req, res) => {
  const { strategyId } = req.body;
  if (!strategyId) {
    return res.status(400).json({ status: "failed", error: "Missing strategyId in request body" });
  }

  try {
    log.warn(`[ADMIN_CHAOS] Triggering Strategy Sandbox Crash Drill for ${strategyId}`);
    const diag = await chaosTestingFramework.executeSandboxCrashDrill(strategyId);
    res.json({ status: "success", diagnostics: diag });
  } catch (err: any) {
    res.status(500).json({ status: "failed", error: err.message });
  }
});

/**
 * Trigger Redis Outage & Auto-Recovery Test
 */
router.post("/redis-recovery", async (req, res) => {
  try {
    log.warn("[ADMIN_CHAOS] Triggering Redis Outage Recovery Drill");
    const diag = await chaosTestingFramework.executeRedisRecoveryTest();
    res.json({ status: "success", diagnostics: diag });
  } catch (err: any) {
    res.status(500).json({ status: "failed", error: err.message });
  }
});

/**
 * Trigger MongoDB Network partition reconnect test
 */
router.post("/mongo-reconnect", async (req, res) => {
  try {
    log.warn("[ADMIN_CHAOS] Triggering MongoDB partition Reconnect Drill");
    const diag = await chaosTestingFramework.executeMongoReconnectTest();
    res.json({ status: "success", diagnostics: diag });
  } catch (err: any) {
    res.status(500).json({ status: "failed", error: err.message });
  }
});

/**
 * Trigger Websocket Reconnect Drill
 */
router.post("/websocket-reconnect", async (req, res) => {
  try {
    log.warn("[ADMIN_CHAOS] Triggering WebSocket Resubscription Drill");
    const diag = await chaosTestingFramework.executeWebsocketReconnectTest();
    res.json({ status: "success", diagnostics: diag });
  } catch (err: any) {
    res.status(500).json({ status: "failed", error: err.message });
  }
});

/**
 * Trigger active broker session token expiry recovery test
 */
router.post("/token-expiry-recovery", async (req, res) => {
  try {
    log.warn("[ADMIN_CHAOS] Triggering Token Expiry Recovery Drill");
    const diag = await chaosTestingFramework.executeTokenExpiryRecoveryTest();
    res.json({ status: "success", diagnostics: diag });
  } catch (err: any) {
    res.status(500).json({ status: "failed", error: err.message });
  }
});

/**
 * Trigger OMS state replay recovery test
 */
router.post("/oms-replay-recovery", async (req, res) => {
  try {
    log.warn("[ADMIN_CHAOS] Triggering EventSourcedOMS database Replay Drill");
    const diag = await chaosTestingFramework.executeOmsReplayRecoveryTest();
    res.json({ status: "success", diagnostics: diag });
  } catch (err: any) {
    res.status(500).json({ status: "failed", error: err.message });
  }
});

/**
 * Get complete Chaos Audit logs
 */
router.get("/metrics", (req, res) => {
  res.json({
    status: "success",
    experiments: chaosTestingFramework.getExperimentsLog(),
  });
});

export default router;
