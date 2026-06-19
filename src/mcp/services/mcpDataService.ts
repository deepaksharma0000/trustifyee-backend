import mongoose from "mongoose";
import redisConnection from "../../utils/redis";
import { config } from "../../config";
import { MarketStatusService } from "../../services/MarketStatusService";
import { observabilityStack } from "../../services/ObservabilityStack";
import { tickEngineService } from "../../services/TickEngineService";
import { realTimeRiskEngine } from "../../services/RealTimeRiskEngine";
import { eventSourcedOMS } from "../../services/EventSourcedOMS";

export async function getSystemHealthSnapshot() {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    redis: redisConnection.status,
    env: config.nodeEnv,
    executionMode: config.executionMode,
    tickEngineMetrics: tickEngineService.getMetrics(),
    riskEngineMetrics: realTimeRiskEngine.getMetrics(),
    omsMetrics: eventSourcedOMS.getMetrics(),
  };
}

export function getMarketStatusSnapshot() {
  return MarketStatusService.getMarketStatus();
}

export function getObservabilitySnapshot() {
  return {
    metrics: observabilityStack.getSnapshot(),
    alerts: observabilityStack.getAlerts(),
  };
}

export const SUPPORTED_BROKERS = [
  {
    id: "ANGELONE",
    name: "Angel One SmartAPI",
    authPath: "/api/angelone/auth",
    executionQueue: "trade-execution-angelone",
  },
  {
    id: "ALICEBLUE",
    name: "Alice Blue ANT API",
    authPath: "/api/alice/auth",
    executionQueue: "trade-execution-aliceblue",
    note: "Alice Blue is the Indian stock broker — not Alice AI / MCP.",
  },
  {
    id: "UPSTOX",
    name: "Upstox Pro API",
    authPath: "/api/upstox/auth",
    executionQueue: "trade-execution-upstox",
  },
  {
    id: "ZERODHA",
    name: "Zerodha Kite Connect",
    authPath: "/api/zerodha",
    executionQueue: "trade-execution-zerodha",
  },
] as const;
