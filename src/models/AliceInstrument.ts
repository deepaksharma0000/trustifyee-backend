import mongoose, { Document, Schema } from "mongoose";

export interface IAliceInstrument extends Document {
  exchange: string;            // "NSE", "NFO", "MCX", etc.
  token: string;               // instrumentId / token
  tradingSymbol: string;       // e.g. "NIFTY24DEC24000CE"
  symbol: string;              // e.g. "NIFTY"
  instrumentType?: string;     // EQ / FUTIDX / OPTIDX / OPTSTK / FUTSTK ...
  expiry?: Date | null;
  strikePrice?: number | null;
  lotSize?: number | null;
  segment?: string | null;     // NFO, NSE, etc.
  underlyingSymbol?: string | null;
  raw?: any;                   // full original JSON
}

const AliceInstrumentSchema = new Schema<IAliceInstrument>(
  {
    exchange: { type: String, required: true, index: true },
    token: { type: String, required: true },
    tradingSymbol: { type: String, required: true, index: true },
    symbol: { type: String, required: true, index: true },
    instrumentType: { type: String },
    expiry: { type: Date },
    strikePrice: { type: Number },
    lotSize: { type: Number },
    segment: { type: String },
    underlyingSymbol: { type: String },
    raw: { type: Schema.Types.Mixed }
  },
  { timestamps: true }
);

// unique index to avoid duplicates per exchange/token
AliceInstrumentSchema.index({ exchange: 1, token: 1 }, { unique: true });

const AliceInstrumentModel = mongoose.models.AliceInstrument ||
  mongoose.model<IAliceInstrument>("AliceInstrument", AliceInstrumentSchema);

export default AliceInstrumentModel as mongoose.Model<IAliceInstrument>;
