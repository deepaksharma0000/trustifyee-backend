import { Schema, model, Document } from "mongoose";

export interface IAlgoRun extends Document {
  symbol: "NIFTY" | "BANKNIFTY" | "FINNIFTY";
  expiry: Date;
  strategy: string;
  optionSide: "CE" | "PE" | "BOTH";
  status: "running" | "stopped";
  createdBy: string;
  startedAt: Date;
  stoppedAt?: Date;
  stopReason?: string;
  maxTradesPerDay: number;
  maxLossPercent: number;
  stopLossPercent: number;
  targetPercent: number;
}

const AlgoRunSchema = new Schema<IAlgoRun>(
  {
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
  },
  { timestamps: true }
);

export const AlgoRun = model<IAlgoRun>("AlgoRun", AlgoRunSchema);
