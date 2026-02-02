"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AliceInstrumentService = void 0;
// src/services/aliceInstrumentService.ts
const AliceTokens_1 = __importDefault(require("../models/AliceTokens"));
const AliceInstrument_1 = __importDefault(require("../models/AliceInstrument"));
const AliceBlueAdapter_1 = require("../adapters/AliceBlueAdapter");
const logger_1 = require("../utils/logger");
const aliceAdapter = new AliceBlueAdapter_1.AliceBlueAdapter();
class AliceInstrumentService {
    static async getSessionId(clientcode) {
        const doc = await AliceTokens_1.default.findOne({ clientcode }).lean();
        if (!doc || !doc.sessionId) {
            throw new Error(`No Alice sessionId found for clientcode=${clientcode}`);
        }
        return doc.sessionId;
    }
    static async syncExchangeInstruments(params) {
        const { clientcode, exchange } = params;
        // const sessionId = await this.getSessionId(clientcode);
        await this.getSessionId(clientcode);
        const raw = await aliceAdapter.getContractMasterForExchange(exchange);
        if (!Array.isArray(raw)) {
            throw new Error("Contract master adapter did not return an array");
        }
        console.log("Alice contract master raw response ===>");
        console.log(JSON.stringify(raw.slice(0, 3), null, 2));
        // 🔹 unwrap: agar raw[0] khud ek array hai, use hi rows maan lo
        let rowsAny = raw;
        if (Array.isArray(raw[0])) {
            rowsAny = raw[0];
        }
        const rows = rowsAny;
        let inserted = 0;
        let skipped = 0;
        for (const r of rows) {
            // 1) Invalid / non-object rows skip
            if (!r || typeof r !== "object") {
                skipped++;
                continue;
            }
            const row = r;
            // 2) minimal required fields check
            if (!row.exch || !row.token || !row.trading_symbol || !row.symbol) {
                skipped++;
                continue;
            }
            // 3) expiry convert (ms -> Date)
            let expiry = null;
            if (row.expiry_date !== undefined && row.expiry_date !== null) {
                const ms = typeof row.expiry_date === "string"
                    ? Number(row.expiry_date)
                    : row.expiry_date;
                if (!Number.isNaN(ms) && ms > 0) {
                    expiry = new Date(ms);
                }
            }
            // 4) numeric fields
            const strike = row.strike_price !== undefined && row.strike_price !== null
                ? Number(row.strike_price)
                : null;
            const lotSize = row.lot_size !== undefined && row.lot_size !== null
                ? Number(row.lot_size)
                : null;
            await AliceInstrument_1.default.updateOne({ exchange: row.exch, token: row.token }, {
                $set: {
                    exchange: row.exch,
                    token: row.token,
                    tradingSymbol: row.trading_symbol,
                    symbol: row.symbol,
                    instrumentType: row.instrument_type ?? null,
                    expiry,
                    strikePrice: strike,
                    lotSize,
                    segment: row.exchange_segment ?? null,
                    underlyingSymbol: row.symbol,
                    raw: row
                }
            }, { upsert: true });
            inserted++;
        }
        logger_1.log.info(`Alice contract master processed for ${exchange}: inserted/updated=${inserted}, skipped=${skipped}`);
        return { exchange, count: inserted, skipped };
    }
}
exports.AliceInstrumentService = AliceInstrumentService;
