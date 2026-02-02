"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertOptions = upsertOptions;
// src/repositories/optionRepo.ts
const OptionContract_1 = require("../models/OptionContract");
async function upsertOptions(options) {
    const ops = options.map(opt => ({
        updateOne: {
            filter: { instrument_key: opt.instrument_key }, // FIXED
            update: {
                $set: {
                    instrument_key: opt.instrument_key,
                    exchange_token: String(opt.token),
                    tradingsymbol: opt.tradingsymbol,
                    lot_size: opt.lot_size,
                    freeze_quantity: opt.freeze_qty,
                    tick_size: opt.tick_size,
                    expiry: opt.expiry,
                    instrument_type: opt.option_type,
                    strike_price: opt.strike,
                }
            },
            upsert: true
        }
    }));
    return OptionContract_1.OptionContract.bulkWrite(ops, { ordered: false });
}
