// src/index.ts
import express from "express";
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

import upstoxAuthRoutes from "./routes/upstoxAuth";
import upstoxOrder from "./routes/upstoxOrders";
import upstoxAlgoOrderRoutes from "./routes/upstoxAlgoOrderRoutes";
import { fetchAndStoreOptionChain } from "./services/optionService";
import upstoxOrderRoutes from "./routes/upstoxOrderRoutes";
import upstoxInstrumentSyncRoutes from "./routes/upstoxInstrumentSyncRoutes";
import upstoxLtpRoutes from "./routes/upstoxLtpRoutes";



import aliceAuthRoutes from "./routes/aliceAuth";
import aliceOrderRoutes from "./routes/aliceOrders";
import aliceInstrumentsRoutes from "./routes/aliceInstruments";
import { syncPendingOrders } from "./jobs/orderSync.job";

import { log } from "./utils/logger";
import cors from "cors";


async function start() {
  log.info("Starting server...");
  await mongoose.connect(config.mongoUri);
  log.info("Connected to MongoDB");
  const result = await fetchAndStoreOptionChain("NSE_INDEX|Nifty 50");
  console.log(result);

  const app = express();

  app.use(cors());
  app.use(bodyParser.json());


  // Angel One
  await syncNiftyOptionsOnly();
console.log("✅ Clean NIFTY OPTIDX sync done");

await syncBankNiftyOptionsOnly();
console.log("✅ Clean BANKNIFTY OPTIDX sync done");
  app.use("/api/auth", authRoutes);
  app.use("/api/orders", orderRoutes);
  app.use("/api/instruments", instrumentRoutes);
  app.use(bodyParser.json());
  app.use("/api/nifty", niftyRoutes);
  app.use("/api/orders", orderRoutess);
  app.use("/api/positions", positionRoutes);
  app.use("/api/pnl", pnlRoutes);
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
  
  
  // Alice Blue
  
  app.use("/api/alice", aliceAuthRoutes);
  app.use("/api/alice/orders", aliceOrderRoutes);
  app.use("/api/alice/ins", aliceInstrumentsRoutes);

  app.get("/", (_req, res) =>
    res.send("AngelOne + Upstox + AliceBlue TypeScript adapter running")
  );

  app.listen(config.port, () =>
    log.info(`Server listening on port ${config.port}`)
  );
}

start().catch((err) => {
  log.error("Failed to start:", err);
  process.exit(1);
});