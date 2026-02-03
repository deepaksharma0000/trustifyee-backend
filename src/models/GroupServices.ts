import mongoose, { Schema, Document } from 'mongoose';

export interface ISegment extends Document {
    name: string;
}

const SegmentSchema: Schema = new Schema({
    name: { type: String, required: true },
});

export const Segment = mongoose.model<ISegment>('Segment', SegmentSchema);

export interface IGroup extends Document {
    name: string;
    segment_id: mongoose.Types.ObjectId;
    created_at: Date;
    updated_at: Date;
}

const GroupSchema: Schema = new Schema({
    name: { type: String, required: true },
    segment_id: { type: Schema.Types.ObjectId, ref: 'Segment', required: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

export const Group = mongoose.model<IGroup>('Group', GroupSchema);
