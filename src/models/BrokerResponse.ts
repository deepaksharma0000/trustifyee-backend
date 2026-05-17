import { Schema, model, Document } from "mongoose";

export interface IBrokerResponse extends Document {
    userId: string;
    clientcode: string;
    orderid?: string;
    tradingsymbol?: string;
    action: string; // e.g. "PLACE_ORDER", "CLOSE_POSITION", "SQUARE_OFF"
    status: "SUCCESS" | "ERROR" | "REJECTED";
    message: string;
    usedIp?: string | null;
    networkRoute?: "USER_STATIC_IP" | "SERVER_SHARED_IP" | "AGENT_ROUTE" | "UNKNOWN";
    brokerError?: any;
    createdAt: Date;
}

const BrokerResponseSchema = new Schema<IBrokerResponse>(
    {
        userId: { type: String, required: true, index: true },
        clientcode: { type: String, required: true, index: true },
        orderid: { type: String },
        tradingsymbol: { type: String },
        action: { type: String, required: true },
        status: { type: String, enum: ["SUCCESS", "ERROR", "REJECTED"], required: true },
        message: { type: String, required: true },
        usedIp: { type: String, default: null },
        networkRoute: { type: String, enum: ["USER_STATIC_IP", "SERVER_SHARED_IP", "AGENT_ROUTE", "UNKNOWN"] },
        brokerError: { type: Schema.Types.Mixed },
    },
    { timestamps: true }
);

export const BrokerResponse = model<IBrokerResponse>("BrokerResponse", BrokerResponseSchema);
