// src/index.ts
import express from "express";
import http from "http";
import bodyParser from "body-parser";
import mongoose from "mongoose";
import { config } from "./config";
import InstrumentModel from "./models/Instrument";
import authRoutes from "./routes/auth";
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

async function updatePublicIp() {
  try {
    const [ipv4, ipv6] = await Promise.all([
      axios.get("https://ipv4.icanhazip.com").then(r => r.data.trim()).catch(() => null),
      axios.get("https://ipv6.icanhazip.com").then(r => r.data.trim()).catch(() => null)
    ]);

    // Prioritize IPv6 if available (since many users whitelist IPv6 range)
    const ip = ipv6 || ipv4;
    (config as any).publicIp = ip;
    log.info(`🌍 Current Public IP updated: ${ip} (v6: ${ipv6 || 'none'}, v4: ${ipv4 || 'none'})`);
  } catch (err: any) {
    log.warn(`⚠️ Failed to fetch public IP: ${err.message}`);
  }
}

async function start() {
  try {
    log.info("🚀 Starting server...");
    
    // [ISSUE 1 FIX] Ensure ENCRYPTION_SECRET is present and length >= 32
    const { validateConfig } = require("./config");
    validateConfig();

    await updatePublicIp();
    setInterval(updatePublicIp, 5 * 60 * 1000); // Update every 5 mins

    log.info(`Connecting to MongoDB at: ${config.mongoUri}`);
    await mongoose.connect(config.mongoUri);
    log.info("✅ Connected to MongoDB");

    // Additional guard check
    if (!config.encryptionKey || config.encryptionKey.length < 32) {
      log.error("❌ CRITICAL: ENCRYPTION_SECRET is missing or too short in .env! Encryption will fail or be insecure.");
      if (config.nodeEnv === 'production') process.exit(1);
    }

    // Validate Lot Sizes (Production Ready Check)
    await forceFixLotSizes();

    // Start Watchdog
    startPositionWatchdog();

    // Start Auto Exit Worker
    initAutoExitWorker();

    // 💹 Initialize dedicated Data Feed Layer
    const { dataFeedService } = require("./services/DataFeedService");
    try {
      await dataFeedService.init();
    } catch (e: any) {
      log.warn(`[DATA_FEED] Initialization failed, will retry on use: ${e.message}`);
    }

    // FIX #8: Recover any AlgoRuns that were "running" before last restart
    await recoverRunningRuns();

    // ----------------------------------------------------------------------
    // ⚡ FORCED FULL SYNC (Required for production accuracy)
    // ----------------------------------------------------------------------
    log.info("🔄 Initiating Forced Instrument Sync (Deleting old + Fresh master)...");
    await syncAllOptionInstruments();
    log.info("✅ AngelOne Options Sync complete.");

    // Upstox Initial Sync (Optional/Non-critical)
    try {
      log.info("Syncing Upstox Option Chain...");
      const result = await fetchAndStoreOptionChain("NSE_INDEX|Nifty 50");
      log.info("✅ Upstox Options Sync success");
    } catch (err: any) {
      log.warn(`⚠️ Upstox Options Sync skipped/failed: ${err.message}`);
    }

    const app = express();
    const allowedOrigins = config.corsOrigins.length > 0
      ? config.corsOrigins
      : ["http://localhost:8080", "http://localhost:3000", "https://your-production-domain.com"];

    app.use(cors({ origin: allowedOrigins, credentials: true }));

    app.use(bodyParser.json());

    // Angel One - Old syncs removed to favor the optimized one above

    // Static
    app.use("/uploads", express.static("uploads"));

    // App Routes
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

    // [NEW] Market Status
    const marketStatusRoutes = require("./routes/marketStatus.routes").default;
    app.use("/api/market", marketStatusRoutes);

    setInterval(() => {
      syncPendingOrders();
    }, 5000);

    // Upstox
    app.use("/api/upstox/auth", upstoxAuthRoutes);
    app.use("/api/upstox/orders", upstoxOrder);
    app.use("/api/upstox", upstoxOrderRoutes);
    app.use("/api/upstox/instruments", upstoxInstrumentSyncRoutes);
    app.use("/api/upstox", upstoxAlgoOrderRoutes);
    app.use("/api/upstox/ltp", upstoxLtpRoutes);

    // Algo engine
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
    // FIX: Health check endpoint
    app.get("/health", (_req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

    const server = http.createServer(app);
    startMarketStream(server);  // LTP stream on /ws/market
    startSignalStream(server);  // FIX #1 — Signal push on /ws/signals

    server.listen(config.port, () =>
      log.info(`📡 Server listening on port ${config.port}`)
    );

  } catch (err: any) {
    log.error("❌ Critical Failure during startup:", err);
    process.exit(1);
  }
}

start();
