// src/models/UpstoxInstrument.ts
import mongoose, { Document, Schema } from "mongoose";

export interface IUpstoxInstrument extends Document {
  instrument_key: string;
  instrument_token: string;
  tradingsymbol?: string;
  name?: string;
  exchange?: string;
  segment?: string;
  instrument_type?: string;
  option_type?: string;
  expiry?: Date | null;
  strike_price?: number | null;
  lot_size?: number | null;
  tick_size?: number | null;
  raw?: any;
}

const UpstoxInstrumentSchema = new Schema<IUpstoxInstrument>(
  {
    instrument_key: { type: String, required: true, index: true },
    instrument_token: { type: String, unique: true, sparse: true },
    tradingsymbol: String,
    name: String,
    exchange: String,
    segment: String,
    instrument_type: String,
    option_type: String,
    expiry: Date,
    strike_price: Number,
    lot_size: Number,
    tick_size: Number,
    raw: Schema.Types.Mixed,
  },
  { timestamps: true }
);

// optional TTL or indexes can be added if you want
const UpstoxInstrumentModel = mongoose.models.UpstoxInstrument ||
  mongoose.model<IUpstoxInstrument>("UpstoxInstrument", UpstoxInstrumentSchema);

export default UpstoxInstrumentModel as mongoose.Model<IUpstoxInstrument>;
