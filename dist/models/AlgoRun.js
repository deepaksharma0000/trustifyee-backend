"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AlgoRun = void 0;
const mongoose_1 = require("mongoose");
const AlgoRunSchema = new mongoose_1.Schema({
    symbol: { type: String, required: true },
    expiry: { type: Date, required: true },
    strategy: { type: String, required: true },
    optionSide: { type: String, enum: ["CE", "PE", "BOTH"], default: "BOTH" },
    status: { type: String, enum: ["running", "stopped"], default: "running" },
    createdBy: { type: String, required: true },
    startedAt: { type: Date, required: true },
    stoppedAt: { type: Date },
    stopReason: { type: String },
    maxTradesPerDay: { type: Number, default: 5 },
    maxLossPercent: { type: Number, default: 2 },
    stopLossPercent: { type: Number, default: 1 },
    targetPercent: { type: Number, default: 2 },
}, { timestamps: true });
exports.AlgoRun = (0, mongoose_1.model)("AlgoRun", AlgoRunSchema);
