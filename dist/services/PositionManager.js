"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startPositionWatchdog = void 0;
const Position_model_1 = require("../models/Position.model");
const MarketDataService_1 = require("./MarketDataService");
const AngelOneAdapter_1 = require("../adapters/AngelOneAdapter");
const logger_1 = require("../utils/logger");
const Instrument_1 = __importDefault(require("../models/Instrument"));
const AngelTokens_1 = __importDefault(require("../models/AngelTokens"));
const adapter = new AngelOneAdapter_1.AngelOneAdapter();
/**
 * WATCHDOG SERVICE
 * Checks open positions every X seconds.
 */
const startPositionWatchdog = () => {
    logger_1.log.info("🔥 Starting Position Watchdog Service...");
    setInterval(async () => {
        try {
            await checkAndManagePositions();
        }
        catch (err) {
            logger_1.log.error("Watchdog Loop Error:", err.message);
        }
    }, 15000); // Check every 15 seconds
};
exports.startPositionWatchdog = startPositionWatchdog;
async function checkAndManagePositions() {
    // 1. Find all OPEN positions
    const positions = await Position_model_1.Position.find({ status: "OPEN" });
    if (positions.length === 0)
        return;
    logger_1.log.debug(`Watchdog: Checking ${positions.length} positions...`);
    for (const p of positions) {
        try {
            let currentSymbolToken = p.symboltoken;
            if (!currentSymbolToken) {
                const inst = await Instrument_1.default.findOne({ tradingsymbol: p.tradingsymbol, exchange: p.exchange }).lean();
                currentSymbolToken = inst?.symboltoken;
            }
            if (!currentSymbolToken)
                continue;
            // Fetch LTP (Throttled & Cached via MarketDataService)
            const ltp = await (0, MarketDataService_1.getInstrumentLtp)(p.exchange, p.tradingsymbol, currentSymbolToken);
            if (!ltp || ltp <= 0)
                continue;
            const pos = p;
            if (pos.stopLossPrice || pos.targetPrice) {
                const isBuy = pos.side === "BUY";
                let limitHit = false;
                let exitReason = "";
                if (isBuy) {
                    if (pos.stopLossPrice && ltp <= pos.stopLossPrice) {
                        limitHit = true;
                        exitReason = "SL Hit";
                    }
                    else if (pos.targetPrice && ltp >= pos.targetPrice) {
                        limitHit = true;
                        exitReason = "Target Hit";
                    }
                }
                else {
                    if (pos.stopLossPrice && ltp >= pos.stopLossPrice) {
                        limitHit = true;
                        exitReason = "SL Hit";
                    }
                    else if (pos.targetPrice && ltp <= pos.targetPrice) {
                        limitHit = true;
                        exitReason = "Target Hit";
                    }
                }
                if (limitHit) {
                    logger_1.log.info(`🚀 Auto-Exit Triggered: ${p.tradingsymbol} | reason: ${exitReason} | LTP: ${ltp} | SL: ${pos.stopLossPrice} | TGT: ${pos.targetPrice}`);
                    // We need a session token for execution
                    const tokens = await AngelTokens_1.default.findOne({ clientcode: p.clientcode }).lean();
                    if (tokens?.jwtToken) {
                        await executeExit(p, tokens.jwtToken, exitReason);
                    }
                    else {
                        logger_1.log.error(`Cannot auto-exit ${p.tradingsymbol}: No token for ${p.clientcode}`);
                    }
                }
            }
        }
        catch (e) {
            if (e.message?.includes('429') || e.message?.includes('403')) {
                logger_1.log.warn('Watchdog hit rate limit via MarketDataService. Skipping rest of run.');
                break;
            }
            logger_1.log.error(`Error checking position ${p.orderid}:`, e.message);
        }
    }
}
async function executeExit(position, jwtToken, reason) {
    try {
        const exitSide = position.side === "BUY" ? "SELL" : "BUY";
        // Place Market Exit
        const apiRes = await adapter.placeOrder(jwtToken, {
            exchange: position.exchange,
            tradingsymbol: position.tradingsymbol,
            transactiontype: exitSide,
            quantity: position.quantity,
            ordertype: "MARKET",
            symboltoken: position.symboltoken,
            producttype: "INTRADAY" // or carry over from position
        });
        if (apiRes && (apiRes.status === true || apiRes.status === "success")) {
            // Update DB
            position.status = "CLOSED";
            position.exitPrice = 0; // we don't know exact execution price yet, need orderbook fetch or assume LTP
            position.exitAt = new Date();
            position.exitOrderId = apiRes.data?.orderid;
            await position.save();
            logger_1.log.info(`✅ Auto-Exit Success: ${position.tradingsymbol}`);
        }
        else {
            logger_1.log.error(`❌ Auto-Exit Failed API: ${JSON.stringify(apiRes)}`);
        }
    }
    catch (err) {
        logger_1.log.error(`❌ Auto-Exit Exception: ${err.message}`);
    }
}
