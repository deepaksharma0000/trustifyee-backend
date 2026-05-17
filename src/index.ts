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
import marketStatusRoutes from "./routes/marketStatus.routes";
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

initAutoExitWorker();
initTradeExecutionWorker();

function setupProcessGuards() {
  process.on("unhandledRejection", (reason) => {
    log.error("[PROCESS] Unhandled promise rejection", { reason });
  });

  process.on("uncaughtException", (error) => {
    log.error("[PROCESS] Uncaught exception", error);

    if (config.nodeEnv === "production") {
      setTimeout(() => process.exit(1), 1500);
    }
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
    runtimeDiagnostics();
    validateConfig();

    await updatePublicIp();
    setInterval(() => {
      updatePublicIp().catch((err) => log.error("[NETWORK] periodic public IP refresh failed", err));
    }, 5 * 60 * 1000);

    await mongoose.connect(config.mongoUri);
    log.info("[DB] MongoDB connected");

    if (!config.encryptionKey || config.encryptionKey.length < 32) {
      throw new Error("ENCRYPTION_SECRET must be at least 32 characters.");
    }

    await forceFixLotSizes();
    startPositionWatchdog();

    await recoverRunningRuns();
    TokenRefreshScheduler.start();

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

    app.use("/api/market", marketStatusRoutes);
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
    log.error("[STARTUP] Boot failed", err);
    process.exit(1);
  }
}

start();
