// src/models/Instrument.ts
import mongoose, { Document, Schema } from "mongoose";

export interface IInstrument extends Document {
  symboltoken: string;
  tradingsymbol: string;
  name?: string;
  exchange: string;         // e.g. "NSE", "NFO", "BSE"
  instrumenttype?: string;  // EQ / OPTIDX / FUTSTK etc.
  strike?: number;
  expiry?: Date;
  optiontype?: "CE" | "PE";
  lotSize?: number;
}

const InstrumentSchema = new Schema<IInstrument>(
  {
    symboltoken: { type: String, required: true, unique: true, index: true },
    tradingsymbol: { type: String, required: true, index: true },
    name: { type: String },
    exchange: { type: String, required: true, index: true },
    instrumenttype: { type: String },
    strike: { type: Number },
    expiry: { type: Date },
    optiontype: { type: String, enum: ["CE", "PE"] },
    lotSize: { type: Number }
  },
  { timestamps: true }
);

const InstrumentModel = mongoose.models.Instrument ||
  mongoose.model<IInstrument>("Instrument", InstrumentSchema);

export default InstrumentModel as mongoose.Model<IInstrument>;
