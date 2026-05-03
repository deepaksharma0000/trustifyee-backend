import { Schema, model, Document } from "mongoose";

export interface ISignal extends Document {
    symbol: string;
    exchange: string;
    side: "BUY" | "SELL";
    tradingsymbol: string;
    symboltoken?: string;
    strike?: number;
    optiontype?: "CE" | "PE";
    expiry?: Date;
    price: number;
    quantity: number;
    status: "ACTIVE" | "EXECUTION_IN_PROGRESS" | "CLOSED" | "PARTIAL" | "FAILED" | "EXPIRED";
    strategy?: string;
    adminOrderId?: string;
    totalExecutions?: number;
    signalType: "ENTRY" | "EXIT";
    executionMode: "SERVER" | "CLIENT";
    createdAt: Date;
    updatedAt: Date;
}

const SignalSchema = new Schema<ISignal>(
    {
        symbol: { type: String, required: true },
        exchange: { type: String, required: true },
        side: { type: String, enum: ["BUY", "SELL"], required: true },
        tradingsymbol: { type: String, required: true },
        symboltoken: { type: String },
        strike: { type: Number },
        optiontype: { type: String, enum: ["CE", "PE"] },
        expiry: { type: Date },
        price: { type: Number, required: true },
        quantity: { type: Number, required: true },
        executionMode: { type: String, enum: ["SERVER", "CLIENT"], default: "CLIENT" },
        status: { type: String, enum: ["ACTIVE", "EXECUTION_IN_PROGRESS", "CLOSED", "PARTIAL", "FAILED", "EXPIRED"], default: "ACTIVE" },
        strategy: { type: String },
        adminOrderId: { type: String },
        totalExecutions: { type: Number, default: 0 },
        signalType: { type: String, enum: ["ENTRY", "EXIT"], default: "ENTRY" },
    },
    { timestamps: true }
);

export const Signal = model<ISignal>("Signal", SignalSchema);
