import mongoose, { Schema, Document } from "mongoose";

export interface IAgent extends Document {
  userId: mongoose.Types.ObjectId;
  agentId: string;
  agentSecret: string; // Encrypted using system secret
  status: "active" | "revoked" | "suspended";
  assignedExecutionIp?: string; // Execution IP this agent is responsible for
  publicIp?: string; // Latest observed public IP of the agent host
  ipRestrictions: string[]; // Whitelisted IP of the agent (optional)
  lastHeartbeatAt?: Date;
  lastHeartbeatStatus?: "ONLINE" | "DEGRADED" | "OFFLINE";
  version: string;
  createdAt: Date;
  updatedAt: Date;
}

const AgentSchema = new Schema<IAgent>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    agentId: { type: String, required: true, unique: true, index: true },
    agentSecret: { type: String, required: true },
    status: { type: String, enum: ["active", "revoked", "suspended"], default: "active" },
    assignedExecutionIp: { type: String, index: true },
    publicIp: { type: String },
    ipRestrictions: { type: [String], default: [] },
    lastHeartbeatAt: { type: Date },
    lastHeartbeatStatus: { type: String, enum: ["ONLINE", "DEGRADED", "OFFLINE"] },
    version: { type: String, default: "1.0.0" }
  },
  { timestamps: true }
);

const AgentModel =
  mongoose.models.Agent ||
  mongoose.model<IAgent>("Agent", AgentSchema);

export default AgentModel as mongoose.Model<IAgent>;
