// src/models/TradeOutbox.ts
import mongoose, { Schema, Document } from "mongoose";

export interface ITradeOutbox extends Document {
    payload: any;
    status: "PENDING" | "PROCESSING" | "PROCESSED" | "FAILED";
    correlationId: string;
    attempts: number;
    error?: string;
    processedAt?: Date;
    createdAt: Date;
}

const TradeOutboxSchema = new Schema({
    payload: { type: Object, required: true },
    status: { type: String, enum: ["PENDING", "PROCESSING", "PROCESSED", "FAILED"], default: "PENDING", index: true },
    correlationId: { type: String, required: true, index: true },
    attempts: { type: Number, default: 0 },
    error: { type: String },
    processedAt: { type: Date },
}, { timestamps: true });

export const TradeOutbox = mongoose.model<ITradeOutbox>("TradeOutbox", TradeOutboxSchema);
