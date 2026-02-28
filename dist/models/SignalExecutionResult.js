"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignalExecutionResult = void 0;
const mongoose_1 = require("mongoose");
const SignalExecutionResultSchema = new mongoose_1.Schema({
    signalId: { type: mongoose_1.Schema.Types.ObjectId, ref: "Signal", required: true, index: true },
    userId: { type: mongoose_1.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    broker: { type: String, required: true },
    orderId: { type: String },
    status: { type: String, enum: ["SUCCESS", "FAILED"], required: true },
    errorMessage: { type: String },
    executedAt: { type: Date, default: Date.now },
}, { timestamps: true });
// Unique index to prevent duplicate execution per user per signal
SignalExecutionResultSchema.index({ signalId: 1, userId: 1 }, { unique: true });
exports.SignalExecutionResult = (0, mongoose_1.model)("SignalExecutionResult", SignalExecutionResultSchema);
