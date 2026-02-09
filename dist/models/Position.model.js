"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Position = void 0;
const mongoose_1 = require("mongoose");
const PositionSchema = new mongoose_1.Schema({
    clientcode: { type: String, required: true },
    orderid: { type: String, required: true, unique: true },
    tradingsymbol: { type: String, required: true },
    exchange: { type: String, required: true },
    side: { type: String, enum: ["BUY", "SELL"], required: true },
    quantity: { type: Number, required: true },
    entryPrice: { type: Number, required: true },
    exitPrice: { type: Number },
    stopLossPrice: { type: Number },
    targetPrice: { type: Number },
    symboltoken: { type: String },
    runId: { type: String, index: true },
    strategy: { type: String },
    mode: { type: String, enum: ["live", "paper"], default: "live" },
    status: { type: String, enum: ["PENDING", "COMPLETE", "REJECTED", "OPEN", "CLOSED"], default: "PENDING" },
    exitOrderId: { type: String },
    exitAt: { type: Date }
}, { timestamps: true });
exports.Position = (0, mongoose_1.model)("Position", PositionSchema);
