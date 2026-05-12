import { Schema, model, Document, Types } from "mongoose";

export interface ISignalExecutionResult extends Document {
    signalId: Types.ObjectId;
    userId: Types.ObjectId;
    broker: string;
    orderId?: string;
    clientOrderId?: string;
    status: "PENDING" | "QUEUED" | "SUCCESS" | "FAILED";
    errorMessage?: string;
    executedAt: Date;
    correlationId?: string;

    source?: "USER_DEVICE" | "BACKEND_BLOCKED" | "USER_QUEUE" | "SERVER_QUEUE";
    orderType?: "LIMIT";
    strategyId?: string;
    ipAddress?: string;
    brokerResponse?: unknown;
}

const SignalExecutionResultSchema = new Schema<ISignalExecutionResult>(
    {
        signalId: { type: Schema.Types.ObjectId, ref: "Signal", required: true, index: true },
        userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
        broker: { type: String, required: true },
        orderId: { type: String },
        clientOrderId: { type: String, unique: true, sparse: true, index: true },
        status: { type: String, enum: ["PENDING", "QUEUED", "SUCCESS", "FAILED"], required: true },

        errorMessage: { type: String },
        executedAt: { type: Date, default: Date.now },
        correlationId: { type: String },
        source: { type: String, enum: ["USER_DEVICE", "BACKEND_BLOCKED", "USER_QUEUE", "SERVER_QUEUE"] },
        orderType: { type: String, enum: ["LIMIT"] },
        strategyId: { type: String },
        ipAddress: { type: String },
        brokerResponse: { type: Schema.Types.Mixed },
    },
    { timestamps: true }
);

// Unique index to prevent duplicate execution per user per signal
SignalExecutionResultSchema.index({ signalId: 1, userId: 1 }, { unique: true });

export const SignalExecutionResult = model<ISignalExecutionResult>("SignalExecutionResult", SignalExecutionResultSchema);
