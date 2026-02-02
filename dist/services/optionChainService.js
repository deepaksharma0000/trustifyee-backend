"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOptionChainFromDb = getOptionChainFromDb;
exports.groupByExpiry = groupByExpiry;
exports.pickExpiry = pickExpiry;
exports.findAtmStrike = findAtmStrike;
exports.pickOptionFromChain = pickOptionFromChain;
exports.selectOptionInstrument = selectOptionInstrument;
// src/services/optionChainService.ts
const UpstoxInstrument_1 = __importDefault(require("../models/UpstoxInstrument"));
const logger_1 = require("../utils/logger");
/**
 * Get all options for an underlying from DB
 */
async function getOptionChainFromDb(underlyingSymbol) {
    const regex = new RegExp(`^${underlyingSymbol}\\s`, "i");
    //   const docs = await UpstoxInstrumentModel.find({
    //     segment: "NSE_FO",
    //     instrument_type: { $in: ["OPTIDX", "OPTSTK", "OPT"] },
    //     tradingsymbol: regex,
    //   })
    const docs = await UpstoxInstrument_1.default.find({
        segment: "NSE_FO",
        instrument_type: { $in: ["CE", "PE"] }, // sirf options
        instrument_token: { $ne: null }, // purana null data hata do
        tradingsymbol: regex
    })
        .lean()
        .exec();
    return docs;
}
/**
 * Group chain by expiry
 */
function groupByExpiry(chain) {
    const map = {};
    for (const ins of chain) {
        const key = ins.expiry ? ins.expiry.toISOString().slice(0, 10) : "NO_EXPIRY";
        if (!map[key])
            map[key] = [];
        map[key].push(ins);
    }
    return map;
}
/**
 * Pick nearest or next expiry
 */
function pickExpiry(chain, mode = "NEAREST") {
    const byExpiry = groupByExpiry(chain);
    const today = new Date();
    const expiries = Object.keys(byExpiry)
        .filter((k) => k !== "NO_EXPIRY")
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    if (expiries.length === 0)
        return null;
    const futureExpiries = expiries.filter((d) => new Date(d).getTime() >= today.getTime());
    if (futureExpiries.length === 0)
        return null;
    if (mode === "NEAREST") {
        const exp = futureExpiries[0];
        return { expiry: exp, instruments: byExpiry[exp] };
    }
    else {
        const exp = futureExpiries[Math.min(1, futureExpiries.length - 1)];
        return { expiry: exp, instruments: byExpiry[exp] };
    }
}
/**
 * Find ATM strike for given LTP
 */
function findAtmStrike(instruments, ltp) {
    const strikes = instruments
        .map((i) => i.strike_price)
        .filter((s) => typeof s === "number")
        .sort((a, b) => a - b);
    if (strikes.length === 0)
        return null;
    let best = strikes[0];
    let bestDiff = Math.abs(ltp - best);
    for (const s of strikes) {
        const diff = Math.abs(ltp - s);
        if (diff < bestDiff) {
            best = s;
            bestDiff = diff;
        }
    }
    return best;
}
/**
 * From chain, pick specific option (CE / PE, ATM/±n strike)
 */
function pickOptionFromChain(instruments, params) {
    const { ltp, side, strikesAway = 0 } = params;
    // filter by CE/PE
    const sideFiltered = instruments.filter((i) => i.option_type?.toUpperCase() === side);
    if (sideFiltered.length === 0)
        return null;
    const atmStrike = findAtmStrike(sideFiltered, ltp);
    if (!atmStrike)
        return null;
    // Unique sorted strikes
    const uniqueStrikes = Array.from(new Set(sideFiltered
        .map((i) => i.strike_price)
        .filter((s) => typeof s === "number"))).sort((a, b) => a - b);
    const atmIndex = uniqueStrikes.indexOf(atmStrike);
    if (atmIndex === -1)
        return null;
    const targetIndex = atmIndex + strikesAway;
    if (targetIndex < 0 || targetIndex >= uniqueStrikes.length)
        return null;
    const targetStrike = uniqueStrikes[targetIndex];
    // final instrument for target strike
    const chosen = sideFiltered.find((i) => i.strike_price === targetStrike);
    return chosen || null;
}
/**
 * High-level helper: give me best instrument for params
 */
async function selectOptionInstrument(params) {
    const { underlyingSymbol, expiryMode = "NEAREST" } = params;
    const chain = await getOptionChainFromDb(underlyingSymbol);
    if (!chain || chain.length === 0) {
        logger_1.log.debug("No chain found in DB for underlying:", underlyingSymbol);
        return null;
    }
    const expGroup = pickExpiry(chain, expiryMode);
    if (!expGroup) {
        logger_1.log.debug("No usable expiry found for", underlyingSymbol);
        return null;
    }
    const chosen = pickOptionFromChain(expGroup.instruments, params);
    return chosen;
}
