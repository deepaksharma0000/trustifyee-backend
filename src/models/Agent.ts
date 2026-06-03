import mongoose, { Schema, Document } from "mongoose";

export interface IAgent extends Document {
  userId: mongoose.Types.ObjectId;
  agentId: string;
  agentSecret: string; // Encrypted using system secret
  status: "active" | "revoked" | "suspended";
  ipRestrictions: string[]; // Whitelisted IP of the agent (optional)
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
    ipRestrictions: { type: [String], default: [] },
    version: { type: String, default: "1.0.0" }
  },
  { timestamps: true }
);

const AgentModel =
  mongoose.models.Agent ||
  mongoose.model<IAgent>("Agent", AgentSchema);

export default AgentModel as mongoose.Model<IAgent>;
