// src/index.ts
import express from "express";
import http from "http";
import bodyParser from "body-parser";
import mongoose from "mongoose";
import { config } from "./config";
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



import aliceAuthRoutes from "./routes/aliceAuth";
import aliceOrderRoutes from "./routes/aliceOrders";
import aliceInstrumentsRoutes from "./routes/aliceInstruments";
import { syncPendingOrders } from "./jobs/orderSync.job";

import { log } from "./utils/logger";
import cors from "cors";
import { startMarketStream } from "./services/marketStream";


import { startPositionWatchdog } from "./services/PositionManager";

async function start() {
  log.info("Starting server...");
  await mongoose.connect(config.mongoUri);
  log.info("Connected to MongoDB");

  // Start Watchdog
  startPositionWatchdog();

  try {
    const result = await fetchAndStoreOptionChain("NSE_INDEX|Nifty 50");
    console.log("✅ Upstox Options Sync:", result);
  } catch (err: any) {
    console.warn("⚠️ Upstox Options Sync skipped/failed (Non-critical):", err.message);
  }

  const app = express();

  const allowedOrigins =
    config.corsOrigins.length > 0
      ? config.corsOrigins
      : ["http://localhost:8080", "http://localhost:3000"];

  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
    })
  );
  app.use(bodyParser.json());


  // Angel One
  await syncNiftyOptionsOnly();
  console.log("✅ Clean NIFTY OPTIDX sync done");

  await syncBankNiftyOptionsOnly();
  console.log("✅ Clean BANKNIFTY OPTIDX sync done");

  // Static
  app.use("/uploads", express.static("uploads"));

  // App Routes (Migrated)
  app.use("/api", appAuthRoutes);
  app.use("/api", adminRoutes);
  app.use("/api", userRoutes);
  app.use("/api", adminModuleRoutes);

  app.use("/api/auth", authRoutes);
  app.use("/api/orders", orderRoutes);
  app.use("/api/instruments", instrumentRoutes);
  app.use(bodyParser.json());
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

  // Strategy helper (for manual control with auto-selection)
  app.use("/api/strategy", strategyHelperRoutes);


  // Alice Blue

  app.use("/api/alice", aliceAuthRoutes);
  app.use("/api/alice/orders", aliceOrderRoutes);
  app.use("/api/alice/ins", aliceInstrumentsRoutes);

  app.get("/", (_req, res) =>
    res.send("AngelOne + Upstox + AliceBlue TypeScript adapter running")
  );

  const server = http.createServer(app);
  startMarketStream(server);

  server.listen(config.port, () =>
    log.info(`Server listening on port ${config.port}`)
  );
}

start().catch((err) => {
  log.error("Failed to start:", err);
  process.exit(1);
});
