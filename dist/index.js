"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/index.ts
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const body_parser_1 = __importDefault(require("body-parser"));
const mongoose_1 = __importDefault(require("mongoose"));
const config_1 = require("./config");
const Instrument_1 = __importDefault(require("./models/Instrument"));
const auth_1 = __importDefault(require("./routes/auth"));
const orders_1 = __importDefault(require("./routes/orders"));
const order_routes_1 = __importDefault(require("./routes/order.routes"));
const position_routes_1 = __importDefault(require("./routes/position.routes"));
const InstrumentService_1 = require("./services/InstrumentService");
const instruments_1 = __importDefault(require("./routes/instruments"));
const nifty_1 = __importDefault(require("./routes/nifty"));
const pnl_routes_1 = __importDefault(require("./routes/pnl.routes"));
const webhook_routes_1 = __importDefault(require("./routes/webhook.routes"));
const appAuth_routes_1 = __importDefault(require("./routes/appAuth.routes"));
const admin_routes_1 = __importDefault(require("./routes/admin.routes"));
const user_routes_1 = __importDefault(require("./routes/user.routes"));
const admin_modules_routes_1 = __importDefault(require("./routes/admin_modules.routes"));
const upstoxAuth_1 = __importDefault(require("./routes/upstoxAuth"));
const upstoxOrders_1 = __importDefault(require("./routes/upstoxOrders"));
const upstoxAlgoOrderRoutes_1 = __importDefault(require("./routes/upstoxAlgoOrderRoutes"));
const optionService_1 = require("./services/optionService");
const upstoxOrderRoutes_1 = __importDefault(require("./routes/upstoxOrderRoutes"));
const upstoxInstrumentSyncRoutes_1 = __importDefault(require("./routes/upstoxInstrumentSyncRoutes"));
const upstoxLtpRoutes_1 = __importDefault(require("./routes/upstoxLtpRoutes"));
const algo_routes_1 = __importDefault(require("./routes/algo.routes"));
const strategyHelper_routes_1 = __importDefault(require("./routes/strategyHelper.routes"));
const help_1 = __importDefault(require("./routes/help"));
const aliceAuth_1 = __importDefault(require("./routes/aliceAuth"));
const aliceOrders_1 = __importDefault(require("./routes/aliceOrders"));
const aliceInstruments_1 = __importDefault(require("./routes/aliceInstruments"));
const orderSync_job_1 = require("./jobs/orderSync.job");
const logger_1 = require("./utils/logger");
const cors_1 = __importDefault(require("cors"));
const marketStream_1 = require("./services/marketStream");
const PositionManager_1 = require("./services/PositionManager");
const AutoExitWorker_1 = require("./jobs/AutoExitWorker");
async function start() {
    try {
        logger_1.log.info("🚀 Starting server...");
        await mongoose_1.default.connect(config_1.config.mongoUri);
        logger_1.log.info("✅ Connected to MongoDB");
        // Start Watchdog
        (0, PositionManager_1.startPositionWatchdog)();
        // Start Auto Exit Worker
        (0, AutoExitWorker_1.initAutoExitWorker)();
        // ----------------------------------------------------------------------
        // ⚡ OPTIMIZED SYNC (Only if DB is empty to prevent hang on restart)
        // ----------------------------------------------------------------------
        logger_1.log.info("Checking instrument database status...");
        const instrumentCount = await Instrument_1.default.countDocuments();
        if (instrumentCount < 100) {
            logger_1.log.info(`Instruments empty or low (${instrumentCount}). Syncing AngelOne Master data (Heavy Operation)...`);
            await (0, InstrumentService_1.syncNiftyOptionsOnly)();
            logger_1.log.info("✅ NIFTY OPTIDX sync done");
            await (0, InstrumentService_1.syncBankNiftyOptionsOnly)();
            logger_1.log.info("✅ BANKNIFTY OPTIDX sync done");
        }
        else {
            logger_1.log.info(`✅ Skipping heavy sync: ${instrumentCount} instruments already in DB.`);
        }
        // Upstox Initial Sync (Optional/Non-critical)
        try {
            logger_1.log.info("Syncing Upstox Option Chain...");
            const result = await (0, optionService_1.fetchAndStoreOptionChain)("NSE_INDEX|Nifty 50");
            logger_1.log.info("✅ Upstox Options Sync success");
        }
        catch (err) {
            logger_1.log.warn(`⚠️ Upstox Options Sync skipped/failed: ${err.message}`);
        }
        const app = (0, express_1.default)();
        const allowedOrigins = config_1.config.corsOrigins.length > 0
            ? config_1.config.corsOrigins
            : ["http://localhost:8080", "http://localhost:3000", "https://6920-2405-201-300b-721e-a4ea-b208-cd7d-2464.ngrok-free.app"];
        // app.use(cors({ origin: allowedOrigins, credentials: true }));
        app.use((0, cors_1.default)({ origin: true }));
        app.use(body_parser_1.default.json());
        // Angel One - Old syncs removed to favor the optimized one above
        // Static
        app.use("/uploads", express_1.default.static("uploads"));
        // App Routes
        app.use("/api", appAuth_routes_1.default);
        app.use("/api", admin_routes_1.default);
        app.use("/api", user_routes_1.default);
        app.use("/api", admin_modules_routes_1.default);
        app.use("/api/auth", auth_1.default);
        app.use("/api/orders", orders_1.default);
        app.use("/api/instruments", instruments_1.default);
        app.use("/api/nifty", nifty_1.default);
        app.use("/api/orders", order_routes_1.default);
        app.use("/api/positions", position_routes_1.default);
        app.use("/api/pnl", pnl_routes_1.default);
        app.use("/api/positions", position_routes_1.default);
        app.use("/api/pnl", pnl_routes_1.default);
        app.use("/api/webhook", webhook_routes_1.default);
        // [NEW] Market Status
        const marketStatusRoutes = require("./routes/marketStatus.routes").default;
        app.use("/api/market", marketStatusRoutes);
        setInterval(() => {
            (0, orderSync_job_1.syncPendingOrders)();
        }, 5000);
        // Upstox
        app.use("/api/upstox/auth", upstoxAuth_1.default);
        app.use("/api/upstox/orders", upstoxOrders_1.default);
        app.use("/api/upstox", upstoxOrderRoutes_1.default);
        app.use("/api/upstox/instruments", upstoxInstrumentSyncRoutes_1.default);
        app.use("/api/upstox", upstoxAlgoOrderRoutes_1.default);
        app.use("/api/upstox/ltp", upstoxLtpRoutes_1.default);
        // Algo engine
        app.use("/api/algo", algo_routes_1.default);
        app.use("/api/strategy", strategyHelper_routes_1.default);
        app.use("/api/alice", aliceAuth_1.default);
        app.use("/api/alice/orders", aliceOrders_1.default);
        app.use("/api/alice/ins", aliceInstruments_1.default);
        app.use("/api/help", help_1.default);
        app.get("/", (_req, res) => res.send("Algo Trading System Backend Active"));
        const server = http_1.default.createServer(app);
        (0, marketStream_1.startMarketStream)(server);
        server.listen(config_1.config.port, () => logger_1.log.info(`📡 Server listening on port ${config_1.config.port}`));
    }
    catch (err) {
        logger_1.log.error("❌ Critical Failure during startup:", err);
        process.exit(1);
    }
}
start();
