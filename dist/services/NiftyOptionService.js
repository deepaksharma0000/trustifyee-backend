"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOptionChain = getOptionChain;
exports.getNiftyOptionChain = getNiftyOptionChain;
const Instrument_1 = __importDefault(require("../models/Instrument"));
const config_1 = require("../config");
const optionUtils_1 = require("../utils/optionUtils");
const MarketDataService_1 = require("./MarketDataService");
function formatIstDate(date) {
    return date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
function getIstDayRange(dateStr) {
    const start = new Date(`${dateStr}T00:00:00+05:30`);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
}
const OPTION_CHAIN_CACHE_MS = 5000;
const optionChainCache = new Map();
function getNearestStrike(strikes, atm) {
    if (!strikes.length)
        return 0;
    return strikes.reduce((prev, curr) => Math.abs(curr - atm) < Math.abs(prev - atm) ? curr : prev);
}
async function getOptionChain(symbol = "NIFTY", expiry, strikeRange = 5) {
    const cacheKey = `${symbol}|${expiry || "NEAREST"}|${strikeRange}`;
    const now = Date.now();
    if (optionChainCache.has(cacheKey)) {
        const cached = optionChainCache.get(cacheKey);
        if (now - cached.ts < OPTION_CHAIN_CACHE_MS) {
            return cached.data;
        }
    }
    // 1. Fetch live or fallback LTP
    let currentLtp = await (0, MarketDataService_1.getLiveIndexLtp)(symbol);
    if (currentLtp <= 0 && config_1.config.nodeEnv !== "production") {
        const last = (0, MarketDataService_1.getLastIndexLtp)(symbol);
        if (last > 0)
            currentLtp = last;
    }
    // 2. Fetch all available expiries for this symbol regardless of LTP
    const baseQuery = {
        name: symbol,
        instrumenttype: "OPTIDX",
        expiry: { $gte: new Date() }
    };
    const expiriesData = await Instrument_1.default.distinct("expiry", baseQuery);
    const expiryList = Array.from(new Set(expiriesData
        .map((d) => formatIstDate(new Date(d)))
        .filter((d) => d >= formatIstDate(new Date())))).sort();
    // 3. (REMOVED) If LTP is still 0, we will try to infer it from available strikes so we can at least show the chain.
    /*
    if (currentLtp <= 0) {
      return {
        symbol,
        ltp: 0,
        atmStrike: 0,
        usedStrike: 0,
        options: [],
        expiries: expiryList
      };
    }
    */
    const atm = (0, optionUtils_1.getATMStrike)(currentLtp);
    let targetRange;
    if (expiry) {
        targetRange = getIstDayRange(expiry);
    }
    else if (expiriesData.length) {
        if (expiryList.length) {
            targetRange = getIstDayRange(expiryList[0]);
        }
    }
    const strikeQuery = {
        ...baseQuery,
        ...(targetRange
            ? {
                expiry: {
                    $gte: targetRange.start,
                    $lt: targetRange.end,
                },
            }
            : {}),
    };
    const strikes = await Instrument_1.default.distinct("strike", strikeQuery);
    if (!strikes.length) {
        return {
            symbol,
            ltp: currentLtp,
            atmStrike: atm,
            usedStrike: 0,
            options: [],
            expiries: expiryList
        };
    }
    // Fallback: If LTP is 0, use the median strike as the "current Price" to center the view
    if (currentLtp <= 0) {
        const sortedAll = [...strikes].sort((a, b) => a - b);
        const median = sortedAll[Math.floor(sortedAll.length / 2)];
        currentLtp = median;
        // Recalculate atm with the new fake LTP
    }
    // Re-calculate ATM in case we just updated currentLtp
    const finalAtm = (0, optionUtils_1.getATMStrike)(currentLtp);
    const usedStrike = getNearestStrike(strikes, finalAtm);
    const sorted = strikes.sort((a, b) => a - b);
    const idx = sorted.findIndex((s) => s === usedStrike);
    const minIdx = Math.max(0, idx - strikeRange);
    const maxIdx = Math.min(sorted.length - 1, idx + strikeRange);
    const strikeSet = sorted.slice(minIdx, maxIdx + 1);
    const options = await Instrument_1.default.find({
        ...strikeQuery,
        strike: { $in: strikeSet }
    })
        .sort({ expiry: 1 })
        .select("tradingsymbol strike optiontype expiry symboltoken")
        .lean();
    const response = {
        symbol,
        ltp: currentLtp,
        atmStrike: finalAtm,
        usedStrike,
        options,
        expiries: expiryList
    };
    optionChainCache.set(cacheKey, { ts: Date.now(), data: response });
    return response;
}
// Backward compatibility
async function getNiftyOptionChain(niftyLtp) {
    void niftyLtp;
    return getOptionChain("NIFTY");
}
