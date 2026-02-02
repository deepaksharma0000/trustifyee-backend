"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpstoxInstrumentService = void 0;
// src/services/upstoxInstrumentService.ts
const UpstoxAdapter_1 = require("../adapters/UpstoxAdapter");
const UpstoxInstrument_1 = __importDefault(require("../models/UpstoxInstrument"));
const logger_1 = require("../utils/logger");
class UpstoxInstrumentService {
    constructor() {
        this.adapter = new UpstoxAdapter_1.UpstoxAdapter();
    }
    /**
     * Sync all BOD instruments from Upstox
     */
    async syncBodInstruments(marketType = 'complete') {
        try {
            logger_1.log.info(`Starting BOD instruments sync for: ${marketType}`);
            const instruments = await this.adapter.fetchBodInstruments(marketType);
            if (!Array.isArray(instruments) || instruments.length === 0) {
                throw new Error('No instruments received from Upstox');
            }
            logger_1.log.info(`Processing ${instruments.length} instruments...`);
            const batchSize = 1000;
            let processed = 0;
            let saved = 0;
            for (let i = 0; i < instruments.length; i += batchSize) {
                const batch = instruments.slice(i, i + batchSize);
                const operations = batch.map(instrument => {
                    const mapped = this.mapInstrumentData(instrument);
                    return {
                        updateOne: {
                            filter: { instrument_key: mapped.instrument_key },
                            update: { $set: mapped },
                            upsert: true
                        }
                    };
                });
                if (operations.length > 0) {
                    const result = await UpstoxInstrument_1.default.bulkWrite(operations, { ordered: false });
                    saved += result.upsertedCount + result.modifiedCount;
                }
                processed += batch.length;
                logger_1.log.info(`Processed ${processed}/${instruments.length} instruments...`);
            }
            logger_1.log.info(`BOD sync completed. Processed: ${processed}, Saved/Updated: ${saved}`);
            return {
                success: true,
                processed,
                saved,
                message: `Successfully synced ${saved} instruments`
            };
        }
        catch (error) {
            logger_1.log.error('BOD instruments sync failed:', error);
            throw error;
        }
    }
    /**
     * Map Upstox instrument data to our schema
     */
    mapInstrumentData(instrument) {
        return {
            instrument_key: instrument.instrument_key || `${instrument.exchange}|${instrument.tradingsymbol}`,
            exchange_token: instrument.exchange_token?.toString() || instrument.token?.toString(),
            tradingsymbol: instrument.tradingsymbol || instrument.trading_symbol,
            name: instrument.name || instrument.description || instrument.tradingsymbol,
            exchange: instrument.exchange,
            segment: instrument.segment,
            instrument_type: instrument.instrument_type || instrument.type,
            option_type: instrument.option_type,
            strike_price: instrument.strike_price || instrument.strike,
            expiry_date: instrument.expiry ? new Date(instrument.expiry) : null,
            lot_size: instrument.lot_size || instrument.lot,
            tick_size: instrument.tick_size || instrument.tick,
            isin: instrument.isin,
            last_price: instrument.last_price,
            instrument_token: instrument.instrument_token?.toString() || instrument.token?.toString(),
            broker_token: instrument.broker_token?.toString(),
            company_name: instrument.company_name,
            bse_code: instrument.bse_code,
            nse_code: instrument.nse_code,
            fytoken: instrument.fytoken,
            // Additional fields
            multiplier: instrument.multiplier || 1,
            precision: instrument.precision || 2,
            is_weekly: instrument.is_weekly || false,
            is_fno: instrument.is_fno || false,
            is_index: instrument.is_index || false,
            is_etf: instrument.is_etf || false,
            // Status flags
            is_suspended: instrument.is_suspended || false,
            is_mtf: instrument.is_mtf || false,
            is_mis: instrument.is_mis || false,
            // Timestamps
            last_updated: new Date(),
            // Raw data for reference
            raw_data: instrument
        };
    }
    /**
     * Get instrument by instrument_key
     */
    async getInstrumentByKey(instrumentKey) {
        try {
            const instrument = await UpstoxInstrument_1.default.findOne({
                instrument_key: instrumentKey
            }).lean();
            if (!instrument) {
                throw new Error(`Instrument not found: ${instrumentKey}`);
            }
            return instrument;
        }
        catch (error) {
            logger_1.log.error(`Get instrument by key failed: ${instrumentKey}`, error);
            throw error;
        }
    }
    /**
     * Search instruments
     */
    async searchInstruments(searchTerm, filters = {}) {
        try {
            const query = {
                $or: [
                    { tradingsymbol: { $regex: searchTerm, $options: 'i' } },
                    { instrument_key: { $regex: searchTerm, $options: 'i' } },
                    { name: { $regex: searchTerm, $options: 'i' } }
                ]
            };
            // Apply additional filters
            if (filters.exchange)
                query.exchange = filters.exchange;
            if (filters.segment)
                query.segment = filters.segment;
            if (filters.instrument_type)
                query.instrument_type = filters.instrument_type;
            if (filters.option_type)
                query.option_type = filters.option_type;
            if (filters.expiry_date) {
                query.expiry_date = {
                    $gte: new Date(filters.expiry_date),
                    $lt: new Date(new Date(filters.expiry_date).getTime() + 24 * 60 * 60 * 1000)
                };
            }
            const instruments = await UpstoxInstrument_1.default.find(query)
                .limit(filters.limit || 50)
                .skip(filters.skip || 0)
                .sort({ tradingsymbol: 1 })
                .lean();
            return instruments;
        }
        catch (error) {
            logger_1.log.error('Search instruments failed:', error);
            throw error;
        }
    }
    /**
     * Get option chain for an underlying
     */
    async getOptionChain(underlyingSymbol, expiry) {
        try {
            const query = {
                instrument_type: 'OPTIDX', // OPTIDX for index options, OPTSTK for stock options
                tradingsymbol: { $regex: `^${underlyingSymbol}`, $options: 'i' }
            };
            if (expiry) {
                query.expiry_date = {
                    $gte: new Date(expiry),
                    $lt: new Date(new Date(expiry).getTime() + 24 * 60 * 60 * 1000)
                };
            }
            const options = await UpstoxInstrument_1.default.find(query)
                .sort({ strike_price: 1, option_type: 1 })
                .lean();
            // Group by expiry and strike
            const chain = {};
            options.forEach(option => {
                const expiryStr = option.expiry_date?.toISOString().split('T')[0] || 'unknown';
                if (!chain[expiryStr]) {
                    chain[expiryStr] = {
                        calls: [],
                        puts: []
                    };
                }
                const optionData = {
                    instrument_key: option.instrument_key,
                    tradingsymbol: option.tradingsymbol,
                    strike_price: option.strike_price,
                    lot_size: option.lot_size,
                    tick_size: option.tick_size,
                    last_price: option.last_price,
                    expiry_date: option.expiry_date
                };
                if (option.option_type === 'CE') {
                    chain[expiryStr].calls.push(optionData);
                }
                else if (option.option_type === 'PE') {
                    chain[expiryStr].puts.push(optionData);
                }
            });
            return chain;
        }
        catch (error) {
            logger_1.log.error('Get option chain failed:', error);
            throw error;
        }
    }
    /**
     * Update instrument prices
     */
    async updateInstrumentPrices(liveData) {
        try {
            const operations = liveData.map(data => ({
                updateOne: {
                    filter: { instrument_key: data.instrument_key },
                    update: {
                        $set: {
                            last_price: data.last_price,
                            volume: data.volume,
                            oi: data.oi,
                            change: data.change,
                            change_percent: data.change_percent,
                            last_updated: new Date()
                        }
                    }
                }
            }));
            if (operations.length > 0) {
                await UpstoxInstrument_1.default.bulkWrite(operations, { ordered: false });
            }
        }
        catch (error) {
            logger_1.log.error('Update instrument prices failed:', error);
        }
    }
}
exports.UpstoxInstrumentService = UpstoxInstrumentService;
