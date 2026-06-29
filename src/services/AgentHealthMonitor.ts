import AgentHeartbeatModel from "../models/AgentHeartbeat";
import AgentModel from "../models/Agent";
import { WebSocketAgentServer } from "./WebSocketAgentServer";

export type AgentHealthStatus = "ONLINE" | "DEGRADED" | "OFFLINE";

export type AgentHealthSnapshot = {
  agentId: string;
  assignedExecutionIp?: string | null;
  status: AgentHealthStatus;
  publicIp?: string | null;
  latencyMs?: number | null;
  heartbeatAt?: Date | null;
  heartbeatAgeMs?: number | null;
  source: "WEBSOCKET" | "HEARTBEAT" | "MISSING";
};

const DEGRADED_AFTER_MS = 30_000;
const OFFLINE_AFTER_MS = 90_000;

export class AgentHealthMonitor {
  static async getLatestHeartbeat(agentId: string) {
    return AgentHeartbeatModel.findOne({ agentId }).sort({ timestamp: -1 }).lean();
  }

  static async getHealth(agentId: string): Promise<AgentHealthSnapshot> {
    const agent = await AgentModel.findOne({ agentId }).lean();
    const heartbeat = await this.getLatestHeartbeat(agentId);
    const wsOnline = WebSocketAgentServer.isAgentOnline(agentId);

    if (!heartbeat) {
      return {
        agentId,
        assignedExecutionIp: agent?.assignedExecutionIp || null,
        status: wsOnline ? "DEGRADED" : "OFFLINE",
        publicIp: agent?.publicIp || null,
        latencyMs: null,
        heartbeatAt: null,
        heartbeatAgeMs: null,
        source: "MISSING",
      };
    }

    const heartbeatAt = new Date(heartbeat.timestamp);
    const ageMs = Date.now() - heartbeatAt.getTime();
    let status: AgentHealthStatus = "ONLINE";
    if (!wsOnline || ageMs > OFFLINE_AFTER_MS) {
      status = "OFFLINE";
    } else if (ageMs > DEGRADED_AFTER_MS) {
      status = "DEGRADED";
    }

    return {
      agentId,
      assignedExecutionIp: agent?.assignedExecutionIp || null,
      status,
      publicIp: heartbeat.publicIp || agent?.publicIp || null,
      latencyMs: heartbeat.latencyMs ?? null,
      heartbeatAt,
      heartbeatAgeMs: ageMs,
      source: "HEARTBEAT",
    };
  }
}

export default AgentHealthMonitor;
