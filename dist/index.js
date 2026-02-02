"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/index.ts
const express_1 = __importDefault(require("express"));
const body_parser_1 = __importDefault(require("body-parser"));
const mongoose_1 = __importDefault(require("mongoose"));
const config_1 = require("./config");
const auth_1 = __importDefault(require("./routes/auth"));
const orders_1 = __importDefault(require("./routes/orders"));
const order_routes_1 = __importDefault(require("./routes/order.routes"));
const position_routes_1 = __importDefault(require("./routes/position.routes"));
const InstrumentService_1 = require("./services/InstrumentService");
const instruments_1 = __importDefault(require("./routes/instruments"));
const nifty_1 = __importDefault(require("./routes/nifty"));
const pnl_routes_1 = __importDefault(require("./routes/pnl.routes"));
const upstoxAuth_1 = __importDefault(require("./routes/upstoxAuth"));
const upstoxOrders_1 = __importDefault(require("./routes/upstoxOrders"));
const upstoxAlgoOrderRoutes_1 = __importDefault(require("./routes/upstoxAlgoOrderRoutes"));
const optionService_1 = require("./services/optionService");
const upstoxOrderRoutes_1 = __importDefault(require("./routes/upstoxOrderRoutes"));
const upstoxInstrumentSyncRoutes_1 = __importDefault(require("./routes/upstoxInstrumentSyncRoutes"));
const upstoxLtpRoutes_1 = __importDefault(require("./routes/upstoxLtpRoutes"));
const aliceAuth_1 = __importDefault(require("./routes/aliceAuth"));
const aliceOrders_1 = __importDefault(require("./routes/aliceOrders"));
const aliceInstruments_1 = __importDefault(require("./routes/aliceInstruments"));
const orderSync_job_1 = require("./jobs/orderSync.job");
const logger_1 = require("./utils/logger");
const cors_1 = __importDefault(require("cors"));
async function start() {
    logger_1.log.info("Starting server...");
    await mongoose_1.default.connect(config_1.config.mongoUri);
    logger_1.log.info("Connected to MongoDB");
    const result = await (0, optionService_1.fetchAndStoreOptionChain)("NSE_INDEX|Nifty 50");
    console.log(result);
    const app = (0, express_1.default)();
    app.use((0, cors_1.default)());
    app.use(body_parser_1.default.json());
    // Angel One
    await (0, InstrumentService_1.syncNiftyOptionsOnly)();
    console.log("✅ Clean NIFTY OPTIDX sync done");
    await (0, InstrumentService_1.syncBankNiftyOptionsOnly)();
    console.log("✅ Clean BANKNIFTY OPTIDX sync done");
    app.use("/api/auth", auth_1.default);
    app.use("/api/orders", orders_1.default);
    app.use("/api/instruments", instruments_1.default);
    app.use(body_parser_1.default.json());
    app.use("/api/nifty", nifty_1.default);
    app.use("/api/orders", order_routes_1.default);
    app.use("/api/positions", position_routes_1.default);
    app.use("/api/pnl", pnl_routes_1.default);
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
    // Alice Blue
    app.use("/api/alice", aliceAuth_1.default);
    app.use("/api/alice/orders", aliceOrders_1.default);
    app.use("/api/alice/ins", aliceInstruments_1.default);
    app.get("/", (_req, res) => res.send("AngelOne + Upstox + AliceBlue TypeScript adapter running"));
    app.listen(config_1.config.port, () => logger_1.log.info(`Server listening on port ${config_1.config.port}`));
}
start().catch((err) => {
    logger_1.log.error("Failed to start:", err);
    process.exit(1);
});
