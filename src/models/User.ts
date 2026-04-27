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
    broker_verified: boolean;
    broker_connected: boolean;
    is_online: boolean;
    is_star: boolean;
    lot_multipliers?: Record<string, number>; // { 'NIFTY': 2, 'BANKNIFTY': 1 }
    trading_paused: boolean;
    consecutive_failures: number;
    broker_totp_secret?: string; // [NEW] Added for automated TOTP generation
    broker_password?: string; // [NEW] Added for automated session re-sync
    outgoing_ip?: string; // Binding IP for requests
    strategy_id_map?: Map<string, string>; // { 'Alpha': 'STRAT_001', 'IronCondor': 'STRAT_002' }

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
    password: { type: String, select: false },
    is_login: { type: Boolean, default: false },
    strategies: { type: [String], default: [] },
    api_key: { type: String },
    broker_verified: { type: Boolean, default: false },
    broker_connected: { type: Boolean, default: false },
    is_online: { type: Boolean, default: false },
    is_star: { type: Boolean, default: false },
    lot_multipliers: { type: Map, of: Number, default: {} },
    trading_paused: { type: Boolean, default: false },
    consecutive_failures: { type: Number, default: 0 },
    broker_totp_secret: { type: String }, // [NEW] Added for automated TOTP generation
    broker_password: { type: String }, // [NEW] Added for automated session re-sync
    outgoing_ip: { type: String }, // Static IPv4 assigned to this user
    strategy_id_map: { type: Map, of: String, default: {} },
    execution_node_id: { type: String }, // Docker container ID or Node name
    dedicated_ip_enabled: { type: Boolean, default: false } // Whether user has a dedicated IP environment
 // Mapping internal strategy names to unique broker Strategy IDs

}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

export default mongoose.model<IUser>('User', UserSchema);
