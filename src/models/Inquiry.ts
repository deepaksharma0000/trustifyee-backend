import mongoose, { Schema, Document } from 'mongoose';

export interface IInquiry extends Document {
    full_name: string;
    email: string;
    mobile_number?: string;
    created_at: Date;
    updated_at: Date;
}

const InquirySchema: Schema = new Schema({
    full_name: { type: String, required: true },
    email: { type: String, required: true },
    mobile_number: { type: String },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

export default mongoose.model<IInquiry>('Inquiry', InquirySchema);
