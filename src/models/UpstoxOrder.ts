import mongoose, { Schema, Document } from "mongoose";

export interface IUpstoxOrder extends Document {
  userId: string;
  broker: "UPSTOX";
  order_id: string;
  instrument_token: string;
  tradingsymbol?: string;
  side: "BUY" | "SELL";
  product: string;
  order_type: "MARKET" | "LIMIT";
  quantity: number;
  price: number;
  status: string;          // open, complete, rejected, cancelled, etc.
  raw_request: any;        // payload we sent
  raw_response: any;       // response from Upstox at placement
}

const UpstoxOrderSchema = new Schema<IUpstoxOrder>(
  {
    userId: { type: String, required: true, index: true },
    broker: { type: String, default: "UPSTOX" },
    order_id: { type: String, required: true, unique: true, index: true },
    instrument_token: { type: String, required: true },
    tradingsymbol: String,
    side: { type: String, required: true },
    product: String,
    order_type: String,
    quantity: Number,
    price: Number,
    status: { type: String, default: "PENDING" },
    raw_request: Schema.Types.Mixed,
    raw_response: Schema.Types.Mixed,
  },
  { timestamps: true }
);

export default mongoose.models.UpstoxOrder ||
  mongoose.model<IUpstoxOrder>("UpstoxOrder", UpstoxOrderSchema);
