// src/models/OMSEvent.ts
import mongoose, { Schema, Document } from "mongoose";

export interface IOMSEvent extends Document {
  orderId: string;         // Unique system order tracker ID
  clientOrderId: string;   // Deterministic client order ID
  sequence: number;        // Monotonic ordered sequence number
  eventType: string;       // OMSEventType state
  payload: Record<string, any>;
  createdAt: Date;
}

const OMSEventSchema = new Schema<IOMSEvent>(
  {
    orderId: { type: String, required: true, index: true },
    clientOrderId: { type: String, required: true, index: true },
    sequence: { type: Number, required: true },
    eventType: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

// Compound index to guarantee monotonic ordering per clientOrderId
OMSEventSchema.index({ clientOrderId: 1, sequence: 1 }, { unique: true });

const OMSEventModel =
  mongoose.models.OMSEvent ||
  mongoose.model<IOMSEvent>("OMSEvent", OMSEventSchema);

export default OMSEventModel as mongoose.Model<IOMSEvent>;
