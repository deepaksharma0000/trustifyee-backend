"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findByInstrumentKey = findByInstrumentKey;
// src/services/lookupService.ts
const OptionContract_1 = require("../models/OptionContract");
async function findByInstrumentKey(key) {
    return OptionContract_1.OptionContract.findOne({ instrument_key: key }).lean();
}
