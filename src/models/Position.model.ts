import { Schema, model, Document } from "mongoose";

export interface IPosition extends Document {
  clientcode: string;
  orderid: string;
  exitOrderId?: string;
  tradingsymbol: string;
  exitAt?: Date;
  exchange: string;
  side: "BUY" | "SELL";
  quantity: number;
  entryPrice: number;
  exitPrice?: number;
  symboltoken?: string;
  runId?: string;
  strategy?: string;
  mode?: "live" | "paper";
  status: "PENDING" | "COMPLETE" | "REJECTED" | "OPEN" | "CLOSED";
  createdAt: Date;
}

const PositionSchema = new Schema<IPosition>(
  {
    clientcode: { type: String, required: true },
    orderid: { type: String, required: true, unique: true },
    tradingsymbol: { type: String, required: true },
    exchange: { type: String, required: true },
    side: { type: String, enum: ["BUY", "SELL"], required: true },
    quantity: { type: Number, required: true },
    entryPrice: { type: Number, required: true },
    exitPrice: { type: Number },
    symboltoken: { type: String },
    runId: { type: String, index: true },
    strategy: { type: String },
    mode: { type: String, enum: ["live", "paper"], default: "live" },
    status: { type: String, enum: ["PENDING", "COMPLETE", "REJECTED", "OPEN", "CLOSED"], default: "PENDING" },
    exitOrderId: { type: String },
    exitAt: { type: Date }
  },
  { timestamps: true }
);

export const Position = model<IPosition>("Position", PositionSchema);
