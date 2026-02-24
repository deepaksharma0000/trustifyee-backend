import mongoose, { Schema, Document } from 'mongoose';

export interface ITicket extends Document {
    username: string;
    fullName: string;
    mobile: string;
    email: string;
    message: string;
    status: 'Open' | 'Closed' | 'Pending';
    created_at: Date;
    updated_at: Date;
}

const TicketSchema: Schema = new Schema({
    username: { type: String, required: true },
    fullName: { type: String, required: true },
    mobile: { type: String, required: true },
    email: { type: String, required: true },
    message: { type: String, required: true },
    status: { type: String, enum: ['Open', 'Closed', 'Pending'], default: 'Open' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

export default mongoose.model<ITicket>('Ticket', TicketSchema);
