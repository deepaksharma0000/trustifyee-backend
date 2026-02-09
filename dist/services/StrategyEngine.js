"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.STRATEGY_CONFIGS = void 0;
exports.resolveStrategyLegs = resolveStrategyLegs;
exports.getStrategyConfig = getStrategyConfig;
exports.validateStrategy = validateStrategy;
exports.getAllStrategies = getAllStrategies;
// src/services/StrategyEngine.ts
const logger_1 = require("../utils/logger");
const MarketDataService_1 = require("./MarketDataService");
const optionUtils_1 = require("../utils/optionUtils");
const Instrument_1 = __importDefault(require("../models/Instrument"));
// ============================================
// STRATEGY DEFINITIONS (Production Ready)
// ============================================
exports.STRATEGY_CONFIGS = {
    Alpha: {
        name: "Alpha",
        description: "ATM Straddle - Buy both CE and PE at ATM for high volatility",
        legs: [
            { side: "BUY", optionType: "CE", strikeOffset: 0, quantity: 1 },
            { side: "BUY", optionType: "PE", strikeOffset: 0, quantity: 1 },
        ],
        riskProfile: "HIGH",
        defaultStopLoss: 30,
        defaultTarget: 50,
        maxLossPercent: 3,
    },
    Beta: {
        name: "Beta",
        description: "OTM Strangle - Buy OTM CE and PE for lower cost, higher risk",
        legs: [
            { side: "BUY", optionType: "CE", strikeOffset: 2, quantity: 1 },
            { side: "BUY", optionType: "PE", strikeOffset: -2, quantity: 1 },
        ],
        riskProfile: "MEDIUM",
        defaultStopLoss: 40,
        defaultTarget: 60,
        maxLossPercent: 2,
    },
    Gamma: {
        name: "Gamma",
        description: "Sell ATM Straddle - High premium collection, unlimited risk",
        legs: [
            { side: "SELL", optionType: "CE", strikeOffset: 0, quantity: 1 },
            { side: "SELL", optionType: "PE", strikeOffset: 0, quantity: 1 },
        ],
        riskProfile: "HIGH",
        defaultStopLoss: 20,
        defaultTarget: 30,
        maxLossPercent: 5,
    },
    Delta: {
        name: "Delta",
        description: "Bull Call Spread - Buy ATM CE, Sell OTM CE (Limited risk/reward)",
        legs: [
            { side: "BUY", optionType: "CE", strikeOffset: 0, quantity: 1 },
            { side: "SELL", optionType: "CE", strikeOffset: 2, quantity: 1 },
        ],
        riskProfile: "LOW",
        defaultStopLoss: 25,
        defaultTarget: 40,
        maxLossPercent: 1.5,
    },
    Straddle: {
        name: "Straddle",
        description: "Classic ATM Straddle - Neutral strategy for big moves",
        legs: [
            { side: "BUY", optionType: "CE", strikeOffset: 0, quantity: 1 },
            { side: "BUY", optionType: "PE", strikeOffset: 0, quantity: 1 },
        ],
        riskProfile: "HIGH",
        defaultStopLoss: 30,
        defaultTarget: 50,
        maxLossPercent: 3,
    },
    Strangle: {
        name: "Strangle",
        description: "OTM Strangle - Lower cost than straddle",
        legs: [
            { side: "BUY", optionType: "CE", strikeOffset: 1, quantity: 1 },
            { side: "BUY", optionType: "PE", strikeOffset: -1, quantity: 1 },
        ],
        riskProfile: "MEDIUM",
        defaultStopLoss: 35,
        defaultTarget: 55,
        maxLossPercent: 2.5,
    },
    IronCondor: {
        name: "IronCondor",
        description: "Sell OTM Strangle + Buy further OTM protection",
        legs: [
            { side: "SELL", optionType: "CE", strikeOffset: 1, quantity: 1 },
            { side: "BUY", optionType: "CE", strikeOffset: 3, quantity: 1 },
            { side: "SELL", optionType: "PE", strikeOffset: -1, quantity: 1 },
            { side: "BUY", optionType: "PE", strikeOffset: -3, quantity: 1 },
        ],
        riskProfile: "LOW",
        defaultStopLoss: 40,
        defaultTarget: 50,
        maxLossPercent: 2,
    },
    BullCallSpread: {
        name: "BullCallSpread",
        description: "Bullish strategy - Buy ITM CE, Sell OTM CE",
        legs: [
            { side: "BUY", optionType: "CE", strikeOffset: -1, quantity: 1 },
            { side: "SELL", optionType: "CE", strikeOffset: 2, quantity: 1 },
        ],
        riskProfile: "LOW",
        defaultStopLoss: 25,
        defaultTarget: 40,
        maxLossPercent: 1.5,
    },
    BearPutSpread: {
        name: "BearPutSpread",
        description: "Bearish strategy - Buy ITM PE, Sell OTM PE",
        legs: [
            { side: "BUY", optionType: "PE", strikeOffset: 1, quantity: 1 },
            { side: "SELL", optionType: "PE", strikeOffset: -2, quantity: 1 },
        ],
        riskProfile: "LOW",
        defaultStopLoss: 25,
        defaultTarget: 40,
        maxLossPercent: 1.5,
    },
};
// ============================================
// STRATEGY EXECUTION ENGINE
// ============================================
function formatIstDate(date) {
    return date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
function getIstDayRange(dateStr) {
    const start = new Date(`${dateStr}T00:00:00+05:30`);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
}
function getNearestStrike(strikes, atm) {
    if (!strikes.length)
        return 0;
    return strikes.reduce((prev, curr) => Math.abs(curr - atm) < Math.abs(prev - atm) ? curr : prev);
}
/**
 * Resolve strategy legs to actual instruments
 */
async function resolveStrategyLegs(params) {
    const { symbol, expiry, strategyName, lotSize = 1 } = params;
    const config = exports.STRATEGY_CONFIGS[strategyName];
    if (!config) {
        throw new Error(`Unknown strategy: ${strategyName}`);
    }
    // Get current LTP
    const ltp = await (0, MarketDataService_1.getLiveIndexLtp)(symbol);
    if (ltp <= 0) {
        logger_1.log.warn(`Strategy ${strategyName}: Live LTP unavailable for ${symbol}. Skipping resolution.`);
        return [];
    }
    const atmStrike = (0, optionUtils_1.getATMStrike)(ltp);
    logger_1.log.info(`Strategy ${strategyName}: LTP=${ltp}, ATM=${atmStrike}`);
    // Get expiry range
    const expiryStr = formatIstDate(expiry);
    const expiryRange = getIstDayRange(expiryStr);
    // Get all available strikes for this expiry
    const baseQuery = {
        name: symbol,
        instrumenttype: "OPTIDX",
        expiry: {
            $gte: expiryRange.start,
            $lt: expiryRange.end,
        },
    };
    const strikes = await Instrument_1.default.distinct("strike", baseQuery);
    if (!strikes.length) {
        throw new Error(`No strikes found for ${symbol} on ${expiryStr}`);
    }
    const sortedStrikes = strikes.sort((a, b) => a - b);
    const atmIndex = sortedStrikes.findIndex((s) => s === getNearestStrike(sortedStrikes, atmStrike));
    if (atmIndex === -1) {
        throw new Error(`ATM strike not found in available strikes`);
    }
    // Resolve each leg
    const resolvedLegs = [];
    for (const leg of config.legs) {
        const targetIndex = atmIndex + leg.strikeOffset;
        if (targetIndex < 0 || targetIndex >= sortedStrikes.length) {
            throw new Error(`Strike offset ${leg.strikeOffset} out of range for ${leg.optionType}`);
        }
        const targetStrike = sortedStrikes[targetIndex];
        // Find instrument
        const instrument = await Instrument_1.default.findOne({
            ...baseQuery,
            strike: targetStrike,
            optiontype: leg.optionType,
        })
            .select("tradingsymbol strike optiontype expiry symboltoken")
            .lean();
        if (!instrument) {
            throw new Error(`Instrument not found: ${symbol} ${targetStrike} ${leg.optionType} ${expiryStr}`);
        }
        resolvedLegs.push({
            side: leg.side,
            optionType: leg.optionType,
            tradingsymbol: instrument.tradingsymbol || "",
            strike: targetStrike,
            symboltoken: instrument.symboltoken || "",
            quantity: leg.quantity * lotSize,
            expiry: instrument.expiry || expiry,
        });
        logger_1.log.info(`Resolved leg: ${leg.side} ${leg.optionType} ${targetStrike} (${instrument.tradingsymbol})`);
    }
    return resolvedLegs;
}
/**
 * Get strategy configuration
 */
function getStrategyConfig(strategyName) {
    const config = exports.STRATEGY_CONFIGS[strategyName];
    if (!config) {
        throw new Error(`Unknown strategy: ${strategyName}`);
    }
    return config;
}
/**
 * Validate if strategy can be executed
 */
function validateStrategy(strategyName) {
    const config = exports.STRATEGY_CONFIGS[strategyName];
    if (!config) {
        return { valid: false, error: `Unknown strategy: ${strategyName}` };
    }
    if (config.legs.length === 0) {
        return { valid: false, error: "Strategy has no legs defined" };
    }
    return { valid: true };
}
/**
 * Get all available strategies
 */
function getAllStrategies() {
    return Object.values(exports.STRATEGY_CONFIGS);
}
