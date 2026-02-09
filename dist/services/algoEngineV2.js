"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startRun = startRun;
exports.stopRun = stopRun;
exports.getStatus = getStatus;
exports.getRuns = getRuns;
exports.getTrades = getTrades;
exports.getSummary = getSummary;
// src/services/algoEngineV2.ts - Production Ready Algo Engine with Strategy Support
const User_1 = __importDefault(require("../models/User"));
const AlgoRun_1 = require("../models/AlgoRun");
const AlgoTrade_1 = require("../models/AlgoTrade");
const Position_model_1 = require("../models/Position.model");
const OrderService_1 = require("./OrderService");
const AngelTokens_1 = __importDefault(require("../models/AngelTokens"));
const StrategyEngine_1 = require("./StrategyEngine");
const logger_1 = require("../utils/logger");
const MarketDataService_1 = require("./MarketDataService");
const RUNNERS = new Map();
const EOD_HOUR = 15;
const EOD_MIN = 20;
function startOfDay(d = new Date()) {
    const s = new Date(d);
    s.setHours(0, 0, 0, 0);
    return s;
}
function isEodTime(now = new Date()) {
    return (now.getHours() > EOD_HOUR ||
        (now.getHours() === EOD_HOUR && now.getMinutes() >= EOD_MIN));
}
async function getEntryPrice(jwtToken, exchange, tradingsymbol, symboltoken) {
    return await (0, MarketDataService_1.getInstrumentLtp)(exchange, tradingsymbol, symboltoken);
}
async function squareOffPosition(position) {
    const exitSide = position.side === "BUY" ? "SELL" : "BUY";
    const resp = await (0, OrderService_1.placeOrderForClient)(position.clientcode, {
        exchange: position.exchange,
        tradingsymbol: position.tradingsymbol,
        side: exitSide,
        transactiontype: exitSide,
        quantity: position.quantity,
        ordertype: "MARKET",
    });
    const session = await AngelTokens_1.default.findOne({ clientcode: position.clientcode }).lean();
    const exitPrice = session?.jwtToken && position.symboltoken
        ? await getEntryPrice(session.jwtToken, position.exchange, position.tradingsymbol, position.symboltoken)
        : 0;
    position.status = "CLOSED";
    position.exitOrderId =
        resp?.data?.orderid ||
            resp?.data?.data?.orderid ||
            "MANUAL";
    position.exitAt = new Date();
    position.exitPrice = exitPrice;
    await position.save();
}
async function enforceRisk(run) {
    const openPositions = await Position_model_1.Position.find({
        runId: String(run._id),
        status: "OPEN",
    }).lean();
    if (openPositions.length === 0)
        return;
    let totalEntry = 0;
    let totalPnl = 0;
    for (const p of openPositions) {
        const session = await AngelTokens_1.default.findOne({ clientcode: p.clientcode }).lean();
        if (!session?.jwtToken || !p.symboltoken)
            continue;
        const ltp = await getEntryPrice(session.jwtToken, p.exchange, p.tradingsymbol, p.symboltoken);
        const pnl = p.side === "BUY"
            ? (ltp - p.entryPrice) * p.quantity
            : (p.entryPrice - ltp) * p.quantity;
        totalEntry += p.entryPrice * p.quantity;
        totalPnl += pnl;
        const slPrice = p.side === "BUY"
            ? p.entryPrice * (1 - run.stopLossPercent / 100)
            : p.entryPrice * (1 + run.stopLossPercent / 100);
        const tpPrice = p.side === "BUY"
            ? p.entryPrice * (1 + run.targetPercent / 100)
            : p.entryPrice * (1 - run.targetPercent / 100);
        if ((p.side === "BUY" && (ltp <= slPrice || ltp >= tpPrice)) ||
            (p.side === "SELL" && (ltp >= slPrice || ltp <= tpPrice))) {
            await squareOffPosition(p);
        }
    }
    if (totalEntry > 0) {
        const pnlPercent = (totalPnl / totalEntry) * 100;
        if (pnlPercent <= -run.maxLossPercent) {
            await stopRun(String(run._id), "Max loss hit");
        }
    }
}
// 🔥 NEW: Strategy-based trade placement
async function placeTradesForRun(run) {
    const today = startOfDay();
    const batches = await AlgoTrade_1.AlgoTrade.distinct("batchId", {
        runId: String(run._id),
        createdAt: { $gte: today },
    });
    if (batches.length >= run.maxTradesPerDay) {
        await stopRun(String(run._id), "Max trades reached");
        return;
    }
    // 🔥 Use StrategyEngine to resolve legs
    let resolvedLegs;
    try {
        resolvedLegs = await (0, StrategyEngine_1.resolveStrategyLegs)({
            symbol: run.symbol,
            expiry: run.expiry,
            strategyName: run.strategy,
            lotSize: 1,
        });
        logger_1.log.info(`✅ Strategy ${run.strategy} resolved ${resolvedLegs.length} legs`);
    }
    catch (err) {
        logger_1.log.error(`❌ Strategy resolution failed: ${err.message}`);
        return;
    }
    const batchId = `BATCH-${Date.now()}`;
    const users = await User_1.default.find({
        status: "active",
        trading_status: "enabled",
    }).lean();
    for (const user of users) {
        const clientcode = user.client_key;
        if (!clientcode)
            continue;
        for (const leg of resolvedLegs) {
            if (user.licence === "Demo") {
                const paperId = `PAPER-${Date.now()}-${Math.random()}`;
                await Position_model_1.Position.create({
                    clientcode,
                    orderid: paperId,
                    tradingsymbol: leg.tradingsymbol,
                    exchange: "NFO",
                    side: leg.side,
                    quantity: leg.quantity,
                    entryPrice: 0,
                    symboltoken: leg.symboltoken,
                    status: "OPEN",
                    runId: String(run._id),
                    strategy: run.strategy,
                    mode: "paper",
                });
                await AlgoTrade_1.AlgoTrade.create({
                    runId: String(run._id),
                    batchId,
                    userId: String(user._id),
                    clientcode,
                    orderid: paperId,
                    tradingsymbol: leg.tradingsymbol,
                    optiontype: leg.optionType,
                    strike: leg.strike,
                    side: leg.side,
                    quantity: leg.quantity,
                    mode: "paper",
                    status: "ok",
                });
                continue;
            }
            try {
                const resp = await (0, OrderService_1.placeOrderForClient)(clientcode, {
                    exchange: "NFO",
                    tradingsymbol: leg.tradingsymbol,
                    side: leg.side,
                    transactiontype: leg.side,
                    quantity: leg.quantity,
                    ordertype: "MARKET",
                });
                const orderid = resp?.data?.orderid ||
                    resp?.data?.data?.orderid ||
                    `BROKER-${Date.now()}-${Math.random()}`;
                const session = await AngelTokens_1.default.findOne({ clientcode }).lean();
                const entryPrice = session?.jwtToken && leg.symboltoken
                    ? await getEntryPrice(session.jwtToken, "NFO", leg.tradingsymbol, leg.symboltoken)
                    : 0;
                await Position_model_1.Position.create({
                    clientcode,
                    orderid,
                    tradingsymbol: leg.tradingsymbol,
                    exchange: "NFO",
                    side: leg.side,
                    quantity: leg.quantity,
                    entryPrice: entryPrice || 0,
                    symboltoken: leg.symboltoken,
                    status: "OPEN",
                    runId: String(run._id),
                    strategy: run.strategy,
                    mode: "live",
                });
                await AlgoTrade_1.AlgoTrade.create({
                    runId: String(run._id),
                    batchId,
                    userId: String(user._id),
                    clientcode,
                    orderid,
                    tradingsymbol: leg.tradingsymbol,
                    optiontype: leg.optionType,
                    strike: leg.strike,
                    side: leg.side,
                    quantity: leg.quantity,
                    mode: "live",
                    status: "ok",
                });
            }
            catch (err) {
                await AlgoTrade_1.AlgoTrade.create({
                    runId: String(run._id),
                    batchId,
                    userId: String(user._id),
                    clientcode,
                    orderid: `ERR-${Date.now()}`,
                    tradingsymbol: leg.tradingsymbol,
                    optiontype: leg.optionType,
                    strike: leg.strike,
                    side: leg.side,
                    quantity: leg.quantity,
                    mode: String(user.licence) === "Demo" ? "paper" : "live",
                    status: "error",
                    error: err?.message || String(err),
                });
            }
        }
    }
}
async function startRun(params) {
    const existing = await AlgoRun_1.AlgoRun.findOne({ status: "running" }).lean();
    if (existing) {
        return { ok: false, error: "Algo already running" };
    }
    // Get strategy config for risk parameters
    const strategyConfig = (0, StrategyEngine_1.getStrategyConfig)(params.strategy);
    const run = await AlgoRun_1.AlgoRun.create({
        symbol: params.symbol,
        expiry: params.expiry,
        strategy: params.strategy,
        status: "running",
        createdBy: params.createdBy,
        startedAt: new Date(),
        maxTradesPerDay: 5,
        maxLossPercent: strategyConfig.maxLossPercent,
        stopLossPercent: strategyConfig.defaultStopLoss,
        targetPercent: strategyConfig.defaultTarget,
    });
    logger_1.log.info(`🚀 Starting algo run with strategy: ${params.strategy}`);
    await placeTradesForRun(run);
    const interval = setInterval(async () => {
        const current = await AlgoRun_1.AlgoRun.findById(run._id).lean();
        if (!current || current.status !== "running") {
            clearInterval(interval);
            RUNNERS.delete(String(run._id));
            return;
        }
        if (isEodTime()) {
            await stopRun(String(run._id), "EOD");
            return;
        }
        await enforceRisk(current);
        await placeTradesForRun(current);
    }, 30000);
    RUNNERS.set(String(run._id), interval);
    return { ok: true, run };
}
async function stopRun(runId, reason = "Stopped") {
    const run = await AlgoRun_1.AlgoRun.findById(runId);
    if (!run)
        return { ok: false, error: "Run not found" };
    run.status = "stopped";
    run.stoppedAt = new Date();
    run.stopReason = reason;
    await run.save();
    const timer = RUNNERS.get(runId);
    if (timer) {
        clearInterval(timer);
        RUNNERS.delete(runId);
    }
    const openPositions = await Position_model_1.Position.find({ runId, status: "OPEN" });
    for (const p of openPositions) {
        await squareOffPosition(p);
    }
    logger_1.log.info(`🛑 Stopped algo run: ${reason}`);
    return { ok: true };
}
async function getStatus() {
    const run = await AlgoRun_1.AlgoRun.findOne({ status: "running" }).lean();
    return run || null;
}
async function getRuns(limit = 50) {
    return AlgoRun_1.AlgoRun.find().sort({ createdAt: -1 }).limit(limit).lean();
}
async function getTrades(runId, limit = 200) {
    return AlgoTrade_1.AlgoTrade.find({ runId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
}
async function getSummary(date) {
    const start = date ? new Date(date) : startOfDay();
    const end = new Date(start);
    end.setDate(start.getDate() + 1);
    const trades = await AlgoTrade_1.AlgoTrade.find({
        createdAt: { $gte: start, $lt: end },
    }).lean();
    const totalTrades = trades.length;
    const success = trades.filter((t) => t.status === "ok").length;
    const failed = trades.filter((t) => t.status === "error").length;
    const openPositions = await Position_model_1.Position.countDocuments({
        status: "OPEN",
    });
    const closedPositions = await Position_model_1.Position.find({
        status: "CLOSED",
        exitAt: { $gte: start, $lt: end },
    }).lean();
    const pnl = closedPositions.reduce((sum, p) => {
        const exitPrice = p.exitPrice ?? p.entryPrice;
        const diff = p.side === "BUY" ? (exitPrice - p.entryPrice) : (p.entryPrice - exitPrice);
        return sum + diff * p.quantity;
    }, 0);
    return {
        date: start.toISOString().slice(0, 10),
        totalTrades,
        success,
        failed,
        openPositions,
        closedPositions: closedPositions.length,
        pnl,
    };
}
