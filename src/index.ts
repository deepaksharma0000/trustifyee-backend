// src/index.ts
import express from "express";
import http from "http";
import bodyParser from "body-parser";
import mongoose from "mongoose";
import { config } from "./config";
import InstrumentModel from "./models/Instrument";
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
import cors from "cors";
import { startMarketStream } from "./services/marketStream";
import { startSignalStream } from "./services/signalStream"; // FIX #1
import { recoverRunningRuns } from "./services/algoEngineV2"; // FIX #8


import axios from "axios";
import { startPositionWatchdog } from "./services/PositionManager";
import { initAutoExitWorker } from "./jobs/AutoExitWorker";
import { initTradeExecutionWorker } from "./jobs/TradeExecutionWorker";

// Initialize Workers
initAutoExitWorker();
initTradeExecutionWorker();

import { getPublicIp } from "./utils/ipService";

async function updatePublicIp() {
  try {
    const ip = getPublicIp();
    (config as any).publicIp = ip;

  } catch (err: any) {
    log.warn(`⚠️ Failed to set public IP: ${err.message}`);
  }
}

async function start() {
  try {

    const { validateConfig } = require("./config");
    validateConfig();

    await updatePublicIp();
    setInterval(updatePublicIp, 5 * 60 * 1000); // Update every 5 mins

    await mongoose.connect(config.mongoUri);

    // Additional guard check
    if (!config.encryptionKey || config.encryptionKey.length < 32) {
      if (config.nodeEnv === 'production') process.exit(1);
    }

    // Validate Lot Sizes (Production Ready Check)
    await forceFixLotSizes();

    // Start Watchdog
    startPositionWatchdog();

    // 💹 Initialize dedicated Data Feed Layer
    const { dataFeedService } = require("./services/DataFeedService");
    await recoverRunningRuns();

    try {
      const upstoxUser = await User.findOne({
        broker: { $regex: /^upstox$/i }, // Case-insensitive
        status: 'active',
        broker_connected: true
      }).lean();

      if (!upstoxUser) {
      } else {
        const result = await fetchAndStoreOptionChain("NSE_INDEX|Nifty 50");
      }
    } catch (err: any) {

    }

    const app = express();
    app.use(cors({
      origin: (origin, callback) => {
        const allowed = [
          ...(config.corsOrigins || []),
          "http://localhost:8080",
          "http://localhost:3000",
          config.frontendUrl
        ].filter(Boolean);

        if (!origin || allowed.includes(origin)) {
          callback(null, true);
        } else {
          log.warn(`[CORS] Blocked origin: ${origin}`);
          callback(new Error(`CORS: Origin ${origin} not allowed`));
        }
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "x-access-token", "x-user-id", "x-correlation-id"]
    }));

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

    setInterval(() => OutboxService.processPending(), 2000);

    setInterval(() => MonitoringService.logSystemMetrics(), 60000);

    setInterval(() => {
      syncPendingOrders();
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
    app.use("/api/messages", messageRoutes);
    const ticketRoutes = require("./routes/ticket.routes").default;
    app.use("/api/tickets", ticketRoutes);

    app.get("/", (_req, res) => res.send("Algo Trading System Backend Active"));

    // FIX: Comprehensive Health check endpoint
    app.get("/health", (req, res) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        env: config.nodeEnv,
        executionMode: config.executionMode,
        version: process.env.npm_package_version || '1.0.0'
      });
    });

    const server = http.createServer(app);
    startMarketStream(server);  // LTP stream on /ws/market
    startSignalStream(server);  // FIX #1 — Signal push on /ws/signals

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        log.error(`❌ Port ${config.port} is already in use. Kill the process and restart.`);
        process.exit(1);
      } else {
        throw err;
      }
    });

    server.listen(config.port, async () => {

      try {
        await syncAllOptionInstruments();
      } catch (err: any) {
      }
    });

  } catch (err: any) {
    process.exit(1);
  }
}

start();
