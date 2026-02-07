import { Schema, model, Document } from "mongoose";

export interface IAlgoTrade extends Document {
  runId: string;
  batchId: string;
  userId: string;
  clientcode: string;
  orderid: string;
  tradingsymbol: string;
  optiontype: "CE" | "PE";
  strike: number;
  side: "BUY" | "SELL";
  quantity: number;
  mode: "live" | "paper";
  status: "ok" | "error";
  error?: string;
}

const AlgoTradeSchema = new Schema<IAlgoTrade>(
  {
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
  },
  { timestamps: true }
);

export const AlgoTrade = model<IAlgoTrade>("AlgoTrade", AlgoTradeSchema);
