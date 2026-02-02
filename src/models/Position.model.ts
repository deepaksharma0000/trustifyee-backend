import { Schema, model, Document } from "mongoose";

export interface IPosition extends Document {
  clientcode: string;
  orderid: string;
  exitOrderId: string;
  tradingsymbol: string;
  exitAt: Date;
  exchange: string;
  side: "BUY" | "SELL";
  quantity: number;
  entryPrice: number;
  status: "OPEN" | "CLOSED";
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
    status: { type: String, enum: ["OPEN", "CLOSED"], default: "OPEN" },
    exitOrderId : {type: String, required: true },
    exitAt : {type: Date, required: true}
  },
  { timestamps: true }
);

export const Position = model<IPosition>("Position", PositionSchema);
