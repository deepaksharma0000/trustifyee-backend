import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
    user_name: string;
    email: string;
    full_name?: string;
    client_key?: string;
    phone_number?: string;
    licence: 'Live' | 'Demo';
    to_month?: string;
    sub_admin?: string;
    service_to_month?: string;
    group_service?: string;
    broker?: string;
    status: 'active' | 'inactive';
    trading_status: 'enabled' | 'disabled';
    start_date?: Date;
    end_date?: Date;
    password?: string;
    is_login: boolean;
    strategies?: string[];
    api_key?: string;
    created_at: Date;
    updated_at: Date;
}

const UserSchema: Schema = new Schema({
    user_name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    full_name: { type: String },
    client_key: { type: String, unique: true, sparse: true },
    phone_number: { type: String },
    licence: { type: String, enum: ['Live', 'Demo'], default: 'Live' },
    to_month: { type: String },
    sub_admin: { type: String },
    service_to_month: { type: String },
    group_service: { type: String },
    broker: { type: String },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    trading_status: { type: String, enum: ['enabled', 'disabled'], default: 'enabled' },
    start_date: { type: Date },
    end_date: { type: Date },
    password: { type: String },
    is_login: { type: Boolean, default: false },
    strategies: { type: [String], default: [] },
    api_key: { type: String },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

export default mongoose.model<IUser>('User', UserSchema);
