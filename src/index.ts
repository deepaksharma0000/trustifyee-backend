import express from "express";
import http from "http";
import bodyParser from "body-parser";
import mongoose from "mongoose";
import cors from "cors";

import { config, validateConfig } from "./config";
import authRoutes from "./routes/auth";
import User from "./models/User";
import orderRoutes from "./routes/orders";
import positionRoutes from "./routes/position.routes";
import { syncAllOptionInstruments, forceFixLotSizes } from "./services/InstrumentService";
import instrumentRoutes from "./routes/instruments";
import niftyRoutes from "./routes/nifty";
import pnlRoutes from "./routes/pnl.routes";
import webhookRoutes from "./routes/webhook.routes";
import appAuthRoutes from "./routes/appAuth.routes";
import adminRoutes from "./routes/admin.routes";
import userRoutes from "./routes/user.routes";
import adminModuleRoutes from "./routes/admin_modules.routes";
import upstoxAuthRoutes from "./routes/upstoxAuth";
import upstoxOrder from "./routes/upstoxOrders";
import upstoxAlgoOrderRoutes from "./routes/upstoxAlgoOrderRoutes";
import { fetchAndStoreOptionChain } from "./services/optionService";
import upstoxOrderRoutes from "./routes/upstoxOrderRoutes";
import upstoxInstrumentSyncRoutes from "./routes/upstoxInstrumentSyncRoutes";
import upstoxLtpRoutes from "./routes/upstoxLtpRoutes";
import algoRoutes from "./routes/algo.routes";
import strategyHelperRoutes from "./routes/strategyHelper.routes";
import helpRoutes from "./routes/help";
import signalRoutes from "./routes/signal.routes";
import angeloneAuthRoutes from "./routes/angeloneAuth";
import productRoutes from "./routes/product.routes";
import subscriptionRoutes from "./routes/subscription.routes";
import aliceAuthRoutes from "./routes/aliceAuth";
import aliceOrderRoutes from "./routes/aliceOrders";
import aliceInstrumentsRoutes from "./routes/aliceInstruments";
import { syncPendingOrders } from "./jobs/orderSync.job";
import { syncSignalExecutionStatuses } from "./jobs/signalStatusSync.job";
import marketStatusRoutes from "./routes/marketStatus.routes";
import chaosRoutes from "./routes/chaos.routes";
import observabilityRoutes from "./routes/observability.routes";
import log from "./utils/logger";
import { startMarketStream } from "./services/marketStream";
import { startSignalStream } from "./services/signalStream";
import { recoverRunningRuns } from "./services/algoEngineV2";
import { startPositionWatchdog } from "./services/PositionManager";
import { initAutoExitWorker } from "./jobs/AutoExitWorker";
import { initTradeExecutionWorker } from "./jobs/TradeExecutionWorker";
import { getPublicIp } from "./utils/ipService";
import { requestLogger } from "./middleware/requestLogger.middleware";
import redisConnection from "./utils/redis";
import { TokenRefreshScheduler } from "./services/TokenRefreshScheduler";
import { tickEngineService } from "./services/TickEngineService";
import { realTimeRiskEngine } from "./services/RealTimeRiskEngine";
import { eventSourcedOMS } from "./services/EventSourcedOMS";
import { reconciliationService } from "./services/ReconciliationService";
import { clockDriftMonitor } from "./services/ClockDriftMonitor";
import { sessionAuthority } from "./services/SessionAuthority";
import { strategySandboxRuntime } from "./services/StrategySandboxRuntime";
import { decrypt } from "./utils/encryption";

import { StartupDiagnostics } from "./utils/startupDiagnostics";
import { shutdownAutoExitWorker } from "./jobs/AutoExitWorker";
import { shutdownTradeExecutionWorkers } from "./jobs/TradeExecutionWorker";
import { shutdownTradeQueues } from "./utils/tradeQueue";
import { shutdownAutoExitQueue } from "./services/AutoExitService";
import { initAlgoRiskWorker, shutdownAlgoRiskWorker } from "./services/algoEngineV2";

async function shutdownAll() {
  log.info("[STARTUP] Starting graceful infrastructure teardown...");
  try {
    await shutdownAutoExitWorker();
  } catch (e) {
    log.error("Error shutting down AutoExitWorker:", e);
  }
  try {
    await shutdownTradeExecutionWorkers();
  } catch (e) {
    log.error("Error shutting down TradeExecutionWorker:", e);
  }
  try {
    await shutdownAlgoRiskWorker();
  } catch (e) {
    log.error("Error shutting down AlgoRiskWorker:", e);
  }
  try {
    await shutdownTradeQueues();
  } catch (e) {
    log.error("Error shutting down TradeQueues:", e);
  }
  try {
    await shutdownAutoExitQueue();
  } catch (e) {
    log.error("Error shutting down AutoExitQueue:", e);
  }
  log.info("[STARTUP] Graceful infrastructure teardown complete.");
}

function setupProcessGuards() {
  process.on("unhandledRejection", async (reason) => {
    log.error("[PROCESS] Unhandled promise rejection", { reason });
    if (config.nodeEnv === "production") {
      log.info("[PROCESS] Triggering clean shutdown due to promise rejection...");
      await shutdownAll().catch(() => {});
      process.exit(1);
    }
  });

  process.on("uncaughtException", async (error) => {
    log.error("[PROCESS] Uncaught exception", error);
    log.info("[PROCESS] Triggering clean shutdown due to uncaught exception...");
    await shutdownAll().catch(() => {});
    setTimeout(() => process.exit(1), 1500);
  });
}

function runtimeDiagnostics() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const offsetMinutes = now.getTimezoneOffset();

  log.info("[STARTUP] Runtime diagnostics", {
    nodeEnv: config.nodeEnv,
    executionMode: config.executionMode,
    timezone: tz,
    offsetMinutes,
    nowIso: now.toISOString(),
    publicIp: config.publicIp || "",
    angelClientPublicIp: process.env.ANGEL_CLIENT_PUBLIC_IP || "",
    strictApiKeyRouteValidation: process.env.STRICT_API_KEY_ROUTE_VALIDATION === "true",
  });
}

async function updatePublicIp() {
  try {
    const ip = getPublicIp();
    (config as any).publicIp = ip;
    log.info("[NETWORK] Public IP set", { publicIp: ip });
  } catch (err: any) {
    log.warn("[NETWORK] Failed to set public IP", { message: err?.message });
  }
}

async function start() {
  try {
    setupProcessGuards();

    // Fail-fast on unsafe production config (prevents global fallback + leakage)
    validateConfig();

    // 1. Run all startup dependency checks (includes exponential Mongo retry & Redis compatibility validation)
    await StartupDiagnostics.runAllChecks();

    // 1.1 Load operational feature flags and emergency kill switch configurations
    try {
      const { systemConfigManager } = require("./services/SystemConfigManager");
      await systemConfigManager.initialize();
    } catch (flagErr: any) {
      log.error("[STARTUP] SystemConfigManager initialization failed:", flagErr.message);
    }

    // 2. Initialize workers and queues (only after dependencies are proven healthy)
    initAutoExitWorker();
    initTradeExecutionWorker();
    initAlgoRiskWorker();

    runtimeDiagnostics();

    await updatePublicIp();
    setInterval(() => {
      updatePublicIp().catch((err) => log.error("[NETWORK] periodic public IP refresh failed", err));
    }, 5 * 60 * 1000);

    if (!config.encryptionKey || config.encryptionKey.length < 32) {
      throw new Error("ENCRYPTION_SECRET must be at least 32 characters.");
    }

    await forceFixLotSizes();
    startPositionWatchdog();

    await recoverRunningRuns();
    if (!StartupDiagnostics.isSafeBootMode()) {
      TokenRefreshScheduler.start();
    } else {
      log.warn("[SAFE_BOOT_MODE] TokenRefreshScheduler start bypassed because of startup safety lock.");
    }

    // Start Single-Instance Streaming Market Tick Engine
    tickEngineService.start().catch((err) => {
      log.error("[STARTUP] Failed to initialize system TickEngineService:", err);
    });

    // Start Dedicated Real-Time Risk Monitor Pipeline
    try {
      realTimeRiskEngine.start();
    } catch (err: any) {
      log.error("[STARTUP] Failed to initialize realTimeRiskEngine:", err);
    }

    // Recover EventSourcedOMS state and spawn the pending timeout watchdog
    try {
      await eventSourcedOMS.recoverStateFromDb();
      
      setInterval(() => {
        if (StartupDiagnostics.isSafeBootMode()) return;
        eventSourcedOMS.checkForPendingTimeouts().catch((err) => {
          log.error("[STARTUP] OMS pending timeout check failed:", err);
        });
      }, 5000);

      // Periodically audit positions bidirectionally against the exchange orderbook
      setInterval(async () => {
        if (StartupDiagnostics.isSafeBootMode()) {
          log.debug("[SAFE_BOOT_MODE] Skipping periodic reconciliation audit sweep");
          return;
        }
        try {
          const activeUsers = await User.find({
            status: "active",
            trading_status: "enabled",
            broker_connected: true,
          }).select("_id client_key broker").lean();

          for (const u of activeUsers) {
            const isAngel = String(u.broker).toUpperCase() === "ANGELONE";
            if (isAngel) {
              const clientCode = u.client_key ? decrypt(u.client_key) : "";
              if (clientCode) {
                await reconciliationService.runAudit(String(u._id), clientCode);
              }
            }
          }
        } catch (auditErr: any) {
          log.error("[STARTUP] Periodic reconciliation audit failure:", auditErr.message);
        }
      }, 30000); // Trigger reconciliation every 30 seconds

    } catch (err: any) {
      log.error("[STARTUP] Failed to initialize eventSourcedOMS:", err);
    }

    if (!StartupDiagnostics.isSafeBootMode()) {
      try {
        const upstoxUser = await User.findOne({
          broker: { $regex: /^upstox$/i },
          status: "active",
          broker_connected: true,
        }).lean();

        if (upstoxUser) {
          await fetchAndStoreOptionChain("NSE_INDEX|Nifty 50");
        }
      } catch (err: any) {
        log.warn("[STARTUP] Option chain warmup failed", { message: err?.message });
      }
    } else {
      log.warn("[SAFE_BOOT_MODE] Upstox Nifty option chain warmup bypassed because of startup safety lock.");
    }

    const app = express();

    app.use(
      cors({
        origin: (origin, callback) => {
          const allowed = [
            ...(config.corsOrigins || []),
            "http://localhost:8080",
            "http://localhost:3000",
            config.frontendUrl,
          ].filter(Boolean);

          if (!origin || allowed.includes(origin)) {
            callback(null, true);
            return;
          }

          log.warn("[CORS] Blocked origin", { origin });
          callback(new Error(`CORS: Origin ${origin} not allowed`));
        },
        credentials: true,
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        allowedHeaders: [
          "Content-Type",
          "Authorization",
          "X-Requested-With",
          "x-access-token",
          "x-user-id",
          "x-correlation-id",
        ],
      })
    );

    app.use(requestLogger);
    app.use(bodyParser.json());
    app.use("/uploads", express.static("uploads"));

    app.use("/api", appAuthRoutes);
    app.use("/api", adminRoutes);
    app.use("/api", userRoutes);
    app.use("/api", adminModuleRoutes);

    app.use("/api/auth", authRoutes);
    app.use("/api/orders", orderRoutes);
    app.use("/api/order", orderRoutes);
    app.use("/api/instruments", instrumentRoutes);
    app.use("/api/nifty", niftyRoutes);
    app.use("/api/positions", positionRoutes);
    app.use("/api/pnl", pnlRoutes);
    app.use("/api/webhook", webhookRoutes);

    const { OutboxService } = require("./services/OutboxService");
    const { MonitoringService } = require("./services/MonitoringService");

    setInterval(() => {
      OutboxService.processPending().catch((err: any) => {
        log.error("[OUTBOX] periodic processing failed", err);
      });
    }, 2000);

    setInterval(() => {
      MonitoringService.logSystemMetrics().catch((err: any) => {
        log.error("[MONITOR] metrics collection failed", err);
      });
    }, 60000);

    setInterval(() => {
      syncPendingOrders().catch((err: any) => {
        log.error("[ORDER_SYNC] periodic sync failed", err);
      });
    }, 5000);

    setInterval(() => {
      syncSignalExecutionStatuses().catch((err: any) => {
        log.error("[SIGNAL_STATUS_SYNC] periodic sync failed", err);
      });
    }, Number(process.env.SIGNAL_STATUS_SYNC_INTERVAL_MS || 7000));

    app.use("/api/market", marketStatusRoutes);
    app.use("/api/chaos", chaosRoutes);
    app.use("/api/observability", observabilityRoutes);
    
    const executionRoutes = require("./routes/execution.routes").default;
    app.use("/api/execution", executionRoutes);

    app.use("/api/upstox/auth", upstoxAuthRoutes);
    app.use("/api/upstox/orders", upstoxOrder);
    app.use("/api/upstox", upstoxOrderRoutes);
    app.use("/api/upstox/instruments", upstoxInstrumentSyncRoutes);
    app.use("/api/upstox", upstoxAlgoOrderRoutes);
    app.use("/api/upstox/ltp", upstoxLtpRoutes);

    app.use("/api/algo", algoRoutes);
    app.use("/api/strategy", strategyHelperRoutes);
    app.use("/api/alice", aliceAuthRoutes);
    app.use("/api/alice/orders", aliceOrderRoutes);
    app.use("/api/alice/ins", aliceInstrumentsRoutes);
    app.use("/api/help", helpRoutes);
    app.use("/api/signals", signalRoutes);
    app.use("/api/signal", signalRoutes);
    app.use("/api/product", productRoutes);
    app.use("/api/subscriptions", subscriptionRoutes);
    app.use("/api/angelone/auth", angeloneAuthRoutes);

    const messageRoutes = require("./routes/message.routes").default;
    const ticketRoutes = require("./routes/ticket.routes").default;
    app.use("/api/messages", messageRoutes);
    app.use("/api/tickets", ticketRoutes);

    app.get("/", (_req, res) => res.send("Algo Trading System Backend Active"));

    app.get("/health", (_req, res) => {
      const redisState = redisConnection.status;
      res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
        redis: redisState,
        env: config.nodeEnv,
        executionMode: config.executionMode,
        version: process.env.npm_package_version || "1.0.0",
        tickEngineMetrics: tickEngineService.getMetrics(),
        riskEngineMetrics: realTimeRiskEngine.getMetrics(),
        omsMetrics: eventSourcedOMS.getMetrics(),
        reconciliationMetrics: reconciliationService.getMetrics(),
        temporalMetrics: clockDriftMonitor.getMetrics(),
        sessionMetrics: sessionAuthority.getMetrics(),
        sandboxStatus: "operational",
      });
    });

    app.use((err: any, req: any, res: any, _next: any) => {
      const correlationId = req?.correlationId || req?.headers?.["x-correlation-id"];
      log.error("[HTTP] Unhandled route error", {
        correlationId,
        path: req?.path,
        method: req?.method,
        message: err?.message,
      });

      res.status(err?.statusCode || 500).json({
        status: false,
        error: err?.message || "Internal server error",
        correlationId,
      });
    });

    const server = http.createServer(app);
    startMarketStream(server);
    startSignalStream(server);

    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        log.error("[SERVER] Port already in use", { port: config.port });
      } else {
        log.error("[SERVER] Fatal server error", err);
      }
      process.exit(1);
    });

    server.listen(config.port, async () => {
      log.info("[SERVER] HTTP server started", { port: config.port });

      try {
        await syncAllOptionInstruments();
      } catch (err: any) {
        log.warn("[STARTUP] Background instrument sync failed", { message: err?.message });
      }
    });
  } catch (err: any) {
    log.error("[STARTUP] Boot failed! Executing cleanup rollback...", err);
    await shutdownAll().catch((cleanupErr) => {
      log.error("[STARTUP] Error executing cleanup rollback:", cleanupErr);
    });
    process.exit(1);
  }
}

start();
