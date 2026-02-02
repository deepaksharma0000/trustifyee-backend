"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncNseFoInstruments = syncNseFoInstruments;
// src/services/upstoxInstrumentSyncService.ts
const axios_1 = __importDefault(require("axios"));
const zlib_1 = __importDefault(require("zlib"));
const UpstoxInstrument_1 = __importDefault(require("../models/UpstoxInstrument"));
const logger_1 = require("../utils/logger");
const COMPLETE_URL = "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";
async function syncNseFoInstruments() {
    logger_1.log.info("Starting NSE_FO instruments sync from complete.json.gz...");
    const resp = await axios_1.default.get(COMPLETE_URL, {
        responseType: "arraybuffer",
        timeout: 30000,
    });
    const gunzipped = zlib_1.default.gunzipSync(resp.data);
    const jsonStr = gunzipped.toString("utf-8");
    const instruments = JSON.parse(jsonStr);
    // 1) Sirf NSE_FO segment
    const nseFo = instruments.filter((ins) => ins.segment === "NSE_FO");
    logger_1.log.info("Total NSE_FO instruments:", nseFo.length);
    // 2) NSE_FO me se sirf options: CE / PE
    const optionInstruments = nseFo.filter((ins) => ins.instrument_type === "CE" || ins.instrument_type === "PE");
    logger_1.log.info("Option instruments:", optionInstruments.length);
    if (optionInstruments.length === 0) {
        logger_1.log.debug("No option instruments to upsert.");
        return;
    }
    const bulkOps = optionInstruments.map((ins) => {
        let expiry = null;
        if (ins.expiry !== undefined && ins.expiry !== null) {
            if (typeof ins.expiry === "number") {
                expiry = new Date(ins.expiry); // ms timestamp
            }
            else {
                expiry = new Date(ins.expiry);
            }
        }
        const tradingSymbol = ins.tradingsymbol || ins.trading_symbol;
        const mapped = {
            instrument_key: ins.instrument_key,
            instrument_token: ins.instrument_key, // yahi Upstox order me use karoge
            tradingsymbol: tradingSymbol,
            name: ins.name || tradingSymbol,
            exchange: ins.exchange,
            segment: ins.segment,
            instrument_type: ins.instrument_type, // "CE" / "PE"
            option_type: ins.instrument_type, // for clarity, same store kar lo
            expiry,
            strike_price: ins.strike_price ?? null,
            lot_size: ins.lot_size ?? null,
            tick_size: ins.tick_size ?? null,
            raw: ins,
        };
        return {
            updateOne: {
                filter: { instrument_key: mapped.instrument_key },
                update: { $set: mapped },
                upsert: true,
            },
        };
    });
    const result = await UpstoxInstrument_1.default.bulkWrite(bulkOps, {
        ordered: false,
    });
    logger_1.log.info("NSE_FO option instruments sync complete", {
        matched: result.matchedCount,
        upserted: Object.keys(result.upsertedIds || {}).length,
        modified: result.modifiedCount,
    });
}
