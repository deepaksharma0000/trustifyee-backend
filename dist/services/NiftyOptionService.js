"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getNiftyOptionChain = getNiftyOptionChain;
const Instrument_1 = __importDefault(require("../models/Instrument"));
const optionUtils_1 = require("../utils/optionUtils");
function getNearestStrike(strikes, atm) {
    return strikes.reduce((prev, curr) => Math.abs(curr - atm) < Math.abs(prev - atm) ? curr : prev);
}
async function getNiftyOptionChain(niftyLtp) {
    const atm = (0, optionUtils_1.getATMStrike)(niftyLtp);
    // 1️⃣ All future NIFTY option strikes
    const strikes = await Instrument_1.default.distinct("strike", {
        name: "NIFTY",
        instrumenttype: "OPTIDX",
        expiry: { $gte: new Date() }
    });
    if (!strikes.length) {
        return { niftyLtp, atmStrike: atm, options: [] };
    }
    // 2️⃣ Nearest tradable strike
    const usedStrike = getNearestStrike(strikes, atm);
    // 3️⃣ Fetch CE + PE (nearest expiry first)
    const options = await Instrument_1.default.find({
        name: "NIFTY",
        instrumenttype: "OPTIDX",
        strike: usedStrike
    })
        .sort({ expiry: 1 })
        .select("tradingsymbol strike optiontype expiry symboltoken")
        .lean();
    return {
        niftyLtp,
        atmStrike: atm,
        usedStrike,
        options
    };
}
