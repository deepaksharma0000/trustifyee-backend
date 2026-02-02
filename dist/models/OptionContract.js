"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OptionContract = void 0;
// src/models/OptionContract.ts
const mongoose_1 = __importDefault(require("mongoose"));
const optionSchema = new mongoose_1.default.Schema({
    instrument_key: { type: String, unique: true, index: true },
    trading_symbol: String,
    name: String,
    segment: String,
    exchange: String,
    expiry: String,
    weekly: Boolean,
    exchange_token: String,
    tick_size: Number,
    lot_size: Number,
    freeze_quantity: Number,
    instrument_type: String,
    underlying_key: String,
    underlying_type: String,
    underlying_symbol: String,
    strike_price: Number,
    minimum_lot: Number,
}, { timestamps: true });
exports.OptionContract = mongoose_1.default.model("OptionContract", optionSchema);
