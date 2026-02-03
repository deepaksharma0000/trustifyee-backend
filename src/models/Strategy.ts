import mongoose, { Schema, Document } from 'mongoose';

export interface IStrategy extends Document {
    strategy_name: string;
    segment: string;
    strategy_description?: string;
    created_at: Date;
    updated_at: Date;
}

const StrategySchema: Schema = new Schema({
    strategy_name: { type: String, required: true },
    segment: { type: String, required: true },
    strategy_description: { type: String },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

export default mongoose.model<IStrategy>('Strategy', StrategySchema);
