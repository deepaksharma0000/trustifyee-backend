"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOptionChain = getOptionChain;
exports.getNiftyOptionChain = getNiftyOptionChain;
const Instrument_1 = __importDefault(require("../models/Instrument"));
const optionUtils_1 = require("../utils/optionUtils");
const MarketDataService_1 = require("./MarketDataService");
function getNearestStrike(strikes, atm) {
    if (!strikes.length)
        return 0;
    return strikes.reduce((prev, curr) => Math.abs(curr - atm) < Math.abs(prev - atm) ? curr : prev);
}
async function getOptionChain(symbol = "NIFTY", ltp) {
    let currentLtp = ltp || 0;
    // Fetch live LTP if not provided
    if (currentLtp <= 0) {
        currentLtp = await (0, MarketDataService_1.getLiveIndexLtp)(symbol);
    }
    // Fallback if still 0
    if (currentLtp <= 0) {
        currentLtp = symbol === "NIFTY" ? 25000 : 52000;
    }
    const atm = (0, optionUtils_1.getATMStrike)(currentLtp);
    // 1️⃣ Future option strikes for specific index
    const strikes = await Instrument_1.default.distinct("strike", {
        name: symbol,
        instrumenttype: "OPTIDX",
        expiry: { $gte: new Date() }
    });
    if (!strikes.length) {
        return { ltp: currentLtp, atmStrike: atm, options: [] };
    }
    // 2️⃣ Nearest tradable strike
    const usedStrike = getNearestStrike(strikes, atm);
    // 3️⃣ Fetch CE + PE
    const options = await Instrument_1.default.find({
        name: symbol,
        instrumenttype: "OPTIDX",
        strike: usedStrike
    })
        .sort({ expiry: 1 })
        .select("tradingsymbol strike optiontype expiry symboltoken")
        .lean();
    return {
        symbol,
        ltp: currentLtp,
        atmStrike: atm,
        usedStrike,
        options
    };
}
// Backward compatibility
async function getNiftyOptionChain(niftyLtp) {
    return getOptionChain("NIFTY", niftyLtp);
}
