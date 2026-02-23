"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrokerResponse = void 0;
const mongoose_1 = require("mongoose");
const BrokerResponseSchema = new mongoose_1.Schema({
    userId: { type: String, required: true, index: true },
    clientcode: { type: String, required: true, index: true },
    orderid: { type: String },
    tradingsymbol: { type: String },
    action: { type: String, required: true },
    status: { type: String, enum: ["SUCCESS", "ERROR", "REJECTED"], required: true },
    message: { type: String, required: true },
    brokerError: { type: mongoose_1.Schema.Types.Mixed },
}, { timestamps: true });
exports.BrokerResponse = (0, mongoose_1.model)("BrokerResponse", BrokerResponseSchema);
