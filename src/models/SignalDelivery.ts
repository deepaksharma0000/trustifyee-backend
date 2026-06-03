import mongoose, { Schema, Document } from "mongoose";

export interface ISignalDelivery extends Document {
  signalId: mongoose.Types.ObjectId;
  agentId: string;
  messageId: string;
  status: "PENDING" | "DELIVERED" | "FAILED" | "TIMED_OUT";
  retryCount: number;
  dispatchedAt: Date;
  acknowledgedAt?: Date;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SignalDeliverySchema = new Schema<ISignalDelivery>(
  {
    signalId: { type: Schema.Types.ObjectId, ref: "Signal", required: true, index: true },
    agentId: { type: String, required: true, index: true },
    messageId: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ["PENDING", "DELIVERED", "FAILED", "TIMED_OUT"], default: "PENDING" },
    retryCount: { type: Number, default: 0 },
    dispatchedAt: { type: Date, default: Date.now },
    acknowledgedAt: { type: Date },
    errorMessage: { type: String }
  },
  { timestamps: true }
);

const SignalDeliveryModel =
  mongoose.models.SignalDelivery ||
  mongoose.model<ISignalDelivery>("SignalDelivery", SignalDeliverySchema);

export default SignalDeliveryModel as mongoose.Model<ISignalDelivery>;
