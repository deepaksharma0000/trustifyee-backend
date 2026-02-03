import mongoose, { Schema, Document } from 'mongoose';

export interface IOtp extends Document {
    user_id?: mongoose.Types.ObjectId;
    admin_id?: mongoose.Types.ObjectId;
    otp: string;
    type: 'login' | 'forgot_password';
    status: boolean; // 1 (true) for unused/active?
    used: boolean;
    expires_at?: Date;
    created_at: Date;
}

const OtpSchema: Schema = new Schema({
    user_id: { type: Schema.Types.ObjectId, ref: 'User' },
    admin_id: { type: Schema.Types.ObjectId, ref: 'Admin' },
    otp: { type: String, required: true },
    type: { type: String, enum: ['login', 'forgot_password'], default: 'login' },
    status: { type: Boolean, default: true },
    used: { type: Boolean, default: false },
    expires_at: { type: Date },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

export const Otp = mongoose.model<IOtp>('Otp', OtpSchema);

export interface IClientSave extends Document {
    user_id: mongoose.Types.ObjectId;
    user_name: string;
    email: string;
    created_at: Date;
}

const ClientSaveSchema: Schema = new Schema({
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    user_name: { type: String, required: true },
    email: { type: String, required: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

export const ClientSave = mongoose.model<IClientSave>('ClientSave', ClientSaveSchema);
