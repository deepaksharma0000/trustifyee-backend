import mongoose, { Schema, Document } from 'mongoose';

export interface ISystemSetting extends Document {
    key: string;
    value: any;
    description?: string;
    updated_at: Date;
}

const SystemSettingSchema: Schema = new Schema({
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, required: true },
    description: { type: String },
}, { timestamps: { createdAt: false, updatedAt: 'updated_at' } });

export const SystemSetting = mongoose.model<ISystemSetting>('SystemSetting', SystemSettingSchema);
