import mongoose, { Document, Schema } from "mongoose";

export interface IAngelTokens extends Document {
  userId: mongoose.Types.ObjectId;
  clientcode: string;
  jwtToken?: string;
  refreshToken?: string;
  feedToken?: string;
  apiKey?: string;
  expiresAt?: Date;
  brokerName?: string;
  apiKeyFingerprint?: string;
  outgoingPublicIp?: string;
  registeredRouteIp?: string;
  routeType?: "USER_STATIC_IP" | "SERVER_SHARED_IP" | "AGENT_ROUTE" | "UNKNOWN";
  dedicatedIpEnabled?: boolean;
  agentUrl?: string;
  brokerAppName?: string;
  connectionTimestamp?: Date;
  verificationStatus?: "VERIFIED" | "PENDING" | "FAILED" | "UNKNOWN";
  brokerLoginTimestamp?: Date;
}

const AngelTokensSchema = new Schema<IAngelTokens>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    clientcode: { type: String, required: true, index: true },
    jwtToken: String,
    refreshToken: String,
    feedToken: String,
    apiKey: String,
    expiresAt: Date,
    brokerName: String,
    apiKeyFingerprint: String,
    outgoingPublicIp: String,
    registeredRouteIp: String,
    routeType: { type: String, enum: ["USER_STATIC_IP", "SERVER_SHARED_IP", "AGENT_ROUTE", "UNKNOWN"] },
    dedicatedIpEnabled: { type: Boolean, default: false },
    agentUrl: String,
    brokerAppName: String,
    connectionTimestamp: Date,
    verificationStatus: { type: String, enum: ["VERIFIED", "PENDING", "FAILED", "UNKNOWN"] },
    brokerLoginTimestamp: Date,
  },
  { timestamps: true }
);

AngelTokensSchema.index({ userId: 1, clientcode: 1 }, { unique: true });

const AngelTokensModel =
  mongoose.models.AngelTokens ||
  mongoose.model<IAngelTokens>("AngelTokens", AngelTokensSchema);

export default AngelTokensModel as mongoose.Model<IAngelTokens>;
