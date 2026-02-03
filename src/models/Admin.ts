import mongoose, { Schema, Document } from 'mongoose';

export interface IAdmin extends Document {
    full_name: string;
    mobile: string;
    email: string;
    password: string;
    panel_client_key?: string;
    all_permission: boolean;
    add_client: boolean;
    edit_client: boolean;
    licence_permission: boolean;
    go_to_dashboard: boolean;
    trade_history: boolean;
    full_info_view: boolean;
    update_client_api_key: boolean;
    strategy_permission: boolean;
    group_service_permission: boolean;
    role: 'admin' | 'sub-admin';
    status: 'active' | 'inactive';
    profile_img?: string;
    is_login: boolean;
    created_at: Date;
    updated_at: Date;
}

const AdminSchema: Schema = new Schema({
    full_name: { type: String, required: true },
    mobile: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    panel_client_key: { type: String, unique: true, sparse: true },
    all_permission: { type: Boolean, default: false },
    add_client: { type: Boolean, default: false },
    edit_client: { type: Boolean, default: false },
    licence_permission: { type: Boolean, default: false },
    go_to_dashboard: { type: Boolean, default: false },
    trade_history: { type: Boolean, default: false },
    full_info_view: { type: Boolean, default: false },
    update_client_api_key: { type: Boolean, default: false },
    strategy_permission: { type: Boolean, default: false },
    group_service_permission: { type: Boolean, default: false },
    role: { type: String, enum: ['admin', 'sub-admin'], default: 'sub-admin' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    profile_img: { type: String },
    is_login: { type: Boolean, default: false },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

export default mongoose.model<IAdmin>('Admin', AdminSchema);
