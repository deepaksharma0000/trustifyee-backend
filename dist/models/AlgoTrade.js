"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AlgoTrade = void 0;
const mongoose_1 = require("mongoose");
const AlgoTradeSchema = new mongoose_1.Schema({
    runId: { type: String, index: true, required: true },
    batchId: { type: String, index: true, required: true },
    userId: { type: String, required: true },
    clientcode: { type: String, required: true },
    orderid: { type: String, required: true },
    tradingsymbol: { type: String, required: true },
    optiontype: { type: String, required: true },
    strike: { type: Number, required: true },
    side: { type: String, required: true },
    quantity: { type: Number, required: true },
    mode: { type: String, enum: ["live", "paper"], default: "live" },
    status: { type: String, enum: ["ok", "error"], default: "ok" },
    error: { type: String },
}, { timestamps: true });
exports.AlgoTrade = (0, mongoose_1.model)("AlgoTrade", AlgoTradeSchema);
