// src/index.ts
import express from "express";
import http from "http";
import bodyParser from "body-parser";
import mongoose from "mongoose";
import { config } from "./config";
import InstrumentModel from "./models/Instrument";
import authRoutes from "./routes/auth";
import orderRoutes from "./routes/orders";
import orderRoutess from "./routes/order.routes";
import positionRoutes from "./routes/position.routes";
import { syncBankNiftyOptionsOnly, syncNiftyOptionsOnly } from "./services/InstrumentService";
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



import aliceAuthRoutes from "./routes/aliceAuth";
import aliceOrderRoutes from "./routes/aliceOrders";
import aliceInstrumentsRoutes from "./routes/aliceInstruments";
import { syncPendingOrders } from "./jobs/orderSync.job";

import { log } from "./utils/logger";
import cors from "cors";
import { startMarketStream } from "./services/marketStream";


import { startPositionWatchdog } from "./services/PositionManager";

async function start() {
  try {
    log.info("🚀 Starting server...");
    await mongoose.connect(config.mongoUri);
    log.info("✅ Connected to MongoDB");

    // Start Watchdog
    startPositionWatchdog();

    // ----------------------------------------------------------------------
    // ⚡ OPTIMIZED SYNC (Only if DB is empty to prevent hang on restart)
    // ----------------------------------------------------------------------
    log.info("Checking instrument database status...");
    const instrumentCount = await InstrumentModel.countDocuments();

    if (instrumentCount < 100) {
      log.info(`Instruments empty or low (${instrumentCount}). Syncing AngelOne Master data (Heavy Operation)...`);
      await syncNiftyOptionsOnly();
      log.info("✅ NIFTY OPTIDX sync done");

      await syncBankNiftyOptionsOnly();
      log.info("✅ BANKNIFTY OPTIDX sync done");
    } else {
      log.info(`✅ Skipping heavy sync: ${instrumentCount} instruments already in DB.`);
    }

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
      : ["http://localhost:8080", "http://localhost:3000", "https://6920-2405-201-300b-721e-a4ea-b208-cd7d-2464.ngrok-free.app"];

    // app.use(cors({ origin: allowedOrigins, credentials: true }));
    app.use(cors({ origin: true }));

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
    app.use("/api/instruments", instrumentRoutes);
    app.use("/api/nifty", niftyRoutes);
    app.use("/api/orders", orderRoutess);
    app.use("/api/positions", positionRoutes);
    app.use("/api/pnl", pnlRoutes);
    app.use("/api/webhook", webhookRoutes);

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

    app.get("/", (_req, res) => res.send("Algo Trading System Backend Active"));

    const server = http.createServer(app);
    startMarketStream(server);

    server.listen(config.port, () =>
      log.info(`📡 Server listening on port ${config.port}`)
    );

  } catch (err: any) {
    log.error("❌ Critical Failure during startup:", err);
    process.exit(1);
  }
}

start();
