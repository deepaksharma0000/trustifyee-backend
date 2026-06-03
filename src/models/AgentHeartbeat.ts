import mongoose, { Schema, Document } from "mongoose";

export interface IAgentHeartbeat extends Document {
  agentId: string;
  timestamp: Date;
  status: "ONLINE" | "DEGRADED" | "OFFLINE";
  publicIp: string;
  latencyMs: number;
  metrics: {
    cpuPercent: number;
    memFreeBytes: number;
    uptimeSeconds: number;
  };
}

const AgentHeartbeatSchema = new Schema<IAgentHeartbeat>(
  {
    agentId: { type: String, required: true, index: true },
    timestamp: { type: Date, required: true, default: Date.now, index: { expires: "7d" } }, // Keep logs for 7 days
    status: { type: String, enum: ["ONLINE", "DEGRADED", "OFFLINE"], required: true },
    publicIp: { type: String, required: true },
    latencyMs: { type: Number, required: true },
    metrics: {
      cpuPercent: Number,
      memFreeBytes: Number,
      uptimeSeconds: Number
    }
  }
);

const AgentHeartbeatModel =
  mongoose.models.AgentHeartbeat ||
  mongoose.model<IAgentHeartbeat>("AgentHeartbeat", AgentHeartbeatSchema);

export default AgentHeartbeatModel as mongoose.Model<IAgentHeartbeat>;
