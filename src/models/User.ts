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
    broker_config?: {
        apiKey: string;
        clientCode: string;
        appName?: string;
    };
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
    lot_multipliers?: Map<string, number>; // { 'NIFTY': 2, 'BANKNIFTY': 1 }
    trading_paused: boolean;
    consecutive_failures: number;
    broker_totp_secret?: string; // [NEW] Added for automated TOTP generation
    broker_password?: string; // [NEW] Added for automated session re-sync
    outgoing_ip?: string; // Binding IP for requests
    agent_url?: string; // [NEW] VPS Agent URL for isolated routing
    dedicated_ip_enabled?: boolean; // Explicit opt-in for per-user static IP/agent routing
    api_key_ip_pair_verified?: boolean; // strict guard: key + route pair verified for live trading
    validated_api_key_fingerprint?: string; // masked fingerprint of verified api key
    validated_route_ip?: string; // verified effective route IP
    validated_route_type?: 'USER_STATIC_IP' | 'SERVER_SHARED_IP' | 'AGENT_ROUTE' | 'UNKNOWN';
    validated_pair_at?: Date;
    requiresReconnect?: boolean;
    strategy_id_map?: Map<string, string>; // { 'Alpha': 'STRAT_001', 'IronCondor': 'STRAT_002' }

    // Zerodha Kite Connect credentials & session details
    zerodha_user_id?: string;
    zerodha_api_key?: string;
    zerodha_api_secret?: string;
    zerodha_request_token?: string;
    zerodha_access_token?: string;
    zerodha_refresh_token?: string;
    zerodha_token_expiry?: Date;
    zerodha_connected?: boolean;
    zerodha_verified?: boolean;

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
    broker_config: {
        apiKey: { type: String },
        clientCode: { type: String },
        appName: { type: String }
    },
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
    broker_totp_secret: { type: String, select: false }, // [SECURE] Hidden by default
    broker_password: { type: String, select: false }, // [SECURE] Hidden by default
    outgoing_ip: { type: String }, // Static IPv4 assigned to this user
    agent_url: { type: String }, // URL of the VPS agent (e.g. http://ip:3001)
    strategy_id_map: { type: Map, of: String, default: {} },
    execution_node_id: { type: String }, // Docker container ID or Node name
    dedicated_ip_enabled: { type: Boolean, default: false }, // Whether user has a dedicated IP environment
    api_key_ip_pair_verified: { type: Boolean, default: false },
    validated_api_key_fingerprint: { type: String },
    validated_route_ip: { type: String },
    validated_route_type: { type: String, enum: ['USER_STATIC_IP', 'SERVER_SHARED_IP', 'AGENT_ROUTE', 'UNKNOWN'] },
    validated_pair_at: { type: Date },
    requiresReconnect: { type: Boolean, default: false },
    zerodha_user_id: { type: String },
    zerodha_api_key: { type: String },
    zerodha_api_secret: { type: String },
    zerodha_request_token: { type: String },
    zerodha_access_token: { type: String },
    zerodha_refresh_token: { type: String },
    zerodha_token_expiry: { type: Date },
    zerodha_connected: { type: Boolean, default: false },
    zerodha_verified: { type: Boolean, default: false }
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

/** Migration scripts must $unset enum fields — null fails Mongoose enum validation on login/save. */
UserSchema.pre('save', function (next) {
    const doc = this as any;
    for (const field of [
        'validated_route_type',
        'validated_route_ip',
        'validated_api_key_fingerprint',
        'validated_pair_at',
    ]) {
        if (doc.get(field) === null) {
            doc.set(field, undefined);
        }
    }
    next();
});

export default mongoose.model<IUser>('User', UserSchema);
