import mongoose, { Schema, Document } from 'mongoose';

export interface ISubscriptionRequest extends Document {
    userId: mongoose.Types.ObjectId;
    userName: string;
    planId: string;
    planName: string;
    amount: number;
    durationMonths: number;
    transactionId: string;
    paymentScreenshot?: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    adminRemarks?: string;
    requestedAt: Date;
    processedAt?: Date;
}

const SubscriptionRequestSchema: Schema = new Schema({
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, required: true },
    planId: { type: String, required: true },
    planName: { type: String, required: true },
    amount: { type: Number, required: true },
    durationMonths: { type: Number, required: true },
    transactionId: { type: String, required: true, unique: true },
    paymentScreenshot: { type: String },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
    adminRemarks: { type: String },
    requestedAt: { type: Date, default: Date.now }
}, { timestamps: true });

export const SubscriptionRequest = mongoose.model<ISubscriptionRequest>('SubscriptionRequest', SubscriptionRequestSchema);
