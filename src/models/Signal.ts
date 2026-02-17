import { Schema, model, Document } from "mongoose";

export interface ISignal extends Document {
    symbol: string;
    exchange: string;
    side: "BUY" | "SELL";
    tradingsymbol: string;
    strike?: number;
    optiontype?: "CE" | "PE";
    expiry?: Date;
    price: number;
    quantity: number;
    status: "ACTIVE" | "EXPIRED" | "CLOSED";
    strategy?: string;
    adminOrderId?: string;
    signalType: "ENTRY" | "EXIT";
    createdAt: Date;
    updatedAt: Date;
}

const SignalSchema = new Schema<ISignal>(
    {
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
    },
    { timestamps: true }
);

export const Signal = model<ISignal>("Signal", SignalSchema);
