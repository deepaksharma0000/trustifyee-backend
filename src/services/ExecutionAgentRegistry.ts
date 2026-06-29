import AgentModel from "../models/Agent";
import log from "../utils/logger";
import AgentHealthMonitor, { AgentHealthSnapshot } from "./AgentHealthMonitor";

export type ResolvedExecutionAgent = {
  agent: any;
  health: AgentHealthSnapshot;
};

const normalizeIpv4 = (value?: string): string => {
  const trimmed = String(value || "").trim();
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(trimmed) ? trimmed : "";
};

export class ExecutionAgentRegistry {
  static normalizeExecutionIp(value?: string): string {
    return normalizeIpv4(value);
  }

  static async resolveAgentsForExecutionIp(assignedExecutionIp?: string): Promise<ResolvedExecutionAgent[]> {
    const executionIp = this.normalizeExecutionIp(assignedExecutionIp);
    if (!executionIp) {
      return [];
    }

    const agents = await AgentModel.find({
      assignedExecutionIp: executionIp,
      status: "active",
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    const resolved = await Promise.all(
      agents.map(async (agent) => ({
        agent,
        health: await AgentHealthMonitor.getHealth(String(agent.agentId)),
      }))
    );

    return resolved.sort((left, right) => {
      const rank = (status: string) => (status === "ONLINE" ? 0 : status === "DEGRADED" ? 1 : 2);
      const leftRank = rank(left.health.status);
      const rightRank = rank(right.health.status);
      if (leftRank !== rightRank) return leftRank - rightRank;
      return new Date(right.agent.updatedAt || 0).getTime() - new Date(left.agent.updatedAt || 0).getTime();
    });
  }

  static async resolveBestAgent(assignedExecutionIp?: string): Promise<ResolvedExecutionAgent | null> {
    const candidates = await this.resolveAgentsForExecutionIp(assignedExecutionIp);
    const best = candidates.find((candidate) => candidate.health.status !== "OFFLINE") || candidates[0] || null;
    if (!best) {
      return null;
    }

    log.info("[EXECUTION_AGENT_RESOLVED]", {
      assignedExecutionIp: normalizeIpv4(assignedExecutionIp),
      agentId: best.agent.agentId,
      healthStatus: best.health.status,
      publicIp: best.health.publicIp || "UNKNOWN",
    });

    return best;
  }
}

export default ExecutionAgentRegistry;
