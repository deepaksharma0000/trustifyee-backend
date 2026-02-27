import mongoose, { Schema, Document } from 'mongoose';

export interface ISegment extends Document {
    name: string;
}

const SegmentSchema: Schema = new Schema({
    name: { type: String, required: true },
});

export const Segment = mongoose.model<ISegment>('Segment', SegmentSchema);

export interface ISubService {
    service_id: string;
    name: string;
    segment: string;
    group_qty: number;
    lotsize: string;
    product_type: number;
}

export interface IGroup extends Document {
    name: string;
    description?: string;
    services: ISubService[];
    created_at: Date;
    updated_at: Date;
}

const GroupSchema: Schema = new Schema({
    name: { type: String, required: true },
    description: { type: String, default: null },
    services: [{
        service_id: { type: String, required: true },
        name: { type: String, required: true },
        segment: { type: String, required: true },
        group_qty: { type: Number, default: 0 },
        lotsize: { type: String, default: "1" },
        product_type: { type: Number, default: 1 } // 1: Intraday, 2: Carry Forward
    }]
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

export const Group = mongoose.model<IGroup>('Group', GroupSchema);
