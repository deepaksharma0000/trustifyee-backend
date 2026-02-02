// src/models/OptionContract.ts
import mongoose from "mongoose";

const optionSchema = new mongoose.Schema({
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

export const OptionContract =
  mongoose.model("OptionContract", optionSchema);
