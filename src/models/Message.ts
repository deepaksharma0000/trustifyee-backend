import mongoose, { Schema, Document } from 'mongoose';

export interface IMessage extends Document {
    subject: string;
    message: string;
    target: 'All' | 'Demo';
    created_by: mongoose.Types.ObjectId;
    created_at: Date;
    updated_at: Date;
}

const MessageSchema: Schema = new Schema({
    subject: { type: String, required: true },
    message: { type: String, required: true },
    target: { type: String, enum: ['All', 'Demo'], default: 'All' },
    created_by: { type: Schema.Types.ObjectId, ref: 'Admin', required: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

export default mongoose.model<IMessage>('Message', MessageSchema);
