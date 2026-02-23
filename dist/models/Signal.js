"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Signal = void 0;
const mongoose_1 = require("mongoose");
const SignalSchema = new mongoose_1.Schema({
    symbol: { type: String, required: true },
    exchange: { type: String, required: true },
    side: { type: String, enum: ["BUY", "SELL"], required: true },
    tradingsymbol: { type: String, required: true },
    strike: { type: Number },
    optiontype: { type: String, enum: ["CE", "PE"] },
    expiry: { type: Date },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true },
    status: { type: String, enum: ["ACTIVE", "EXPIRED", "CLOSED"], default: "ACTIVE" },
    strategy: { type: String },
    adminOrderId: { type: String },
    signalType: { type: String, enum: ["ENTRY", "EXIT"], default: "ENTRY" },
}, { timestamps: true });
exports.Signal = (0, mongoose_1.model)("Signal", SignalSchema);
