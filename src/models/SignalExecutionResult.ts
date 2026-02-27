import { Schema, model, Document, Types } from "mongoose";

export interface ISignalExecutionResult extends Document {
    signalId: Types.ObjectId;
    userId: Types.ObjectId;
    broker: string;
    orderId?: string;
    status: "SUCCESS" | "FAILED";
    errorMessage?: string;
    executedAt: Date;
}

const SignalExecutionResultSchema = new Schema<ISignalExecutionResult>(
    {
        signalId: { type: Schema.Types.ObjectId, ref: "Signal", required: true, index: true },
        userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
        broker: { type: String, required: true },
        orderId: { type: String },
        status: { type: String, enum: ["SUCCESS", "FAILED"], required: true },
        errorMessage: { type: String },
        executedAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

// Unique index to prevent duplicate execution per user per signal
SignalExecutionResultSchema.index({ signalId: 1, userId: 1 }, { unique: true });

export const SignalExecutionResult = model<ISignalExecutionResult>("SignalExecutionResult", SignalExecutionResultSchema);
