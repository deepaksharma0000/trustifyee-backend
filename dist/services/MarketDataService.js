"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLiveIndexLtp = getLiveIndexLtp;
exports.getLiveNiftyLtp = getLiveNiftyLtp;
const AngelOneAdapter_1 = require("../adapters/AngelOneAdapter");
const AngelTokens_1 = __importDefault(require("../models/AngelTokens"));
const logger_1 = require("../utils/logger");
const adapter = new AngelOneAdapter_1.AngelOneAdapter();
async function getLiveIndexLtp(indexName = "NIFTY") {
    try {
        const session = await AngelTokens_1.default.findOne({}).sort({ updatedAt: -1 }).lean();
        if (!session || !session.jwtToken) {
            logger_1.log.error(`No active AngelOne session found for Live ${indexName} LTP`);
            return 0;
        }
        // Index Config
        const indexConfig = {
            "NIFTY": { symbol: "Nifty 50", token: "99926000" },
            "BANKNIFTY": { symbol: "Nifty Bank", token: "99926001" },
            "FINNIFTY": { symbol: "Nifty Fin Service", token: "99926037" }
        };
        const config = indexConfig[indexName];
        const resp = await adapter.getLtp(session.jwtToken, "NSE", config.symbol, config.token);
        if (resp && resp.status === true && resp.data) {
            return Number(resp.data.ltp);
        }
        logger_1.log.error(`Failed to fetch ${indexName} LTP from AngelOne`, resp);
        return 0;
    }
    catch (err) {
        logger_1.log.error(`getLiveIndexLtp (${indexName}) error:`, err.message || err);
        return 0;
    }
}
// Keep backward compatibility for now
async function getLiveNiftyLtp() {
    return getLiveIndexLtp("NIFTY");
}
