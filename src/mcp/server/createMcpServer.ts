import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { mcpConfig } from "../config/mcpConfig";
import {
  getSystemHealthSnapshot,
  getMarketStatusSnapshot,
  getObservabilitySnapshot,
  SUPPORTED_BROKERS,
} from "../services/mcpDataService";
import {
  getUserProfileSnapshot,
  getOpenPositionsForUser,
  getActiveSignalsForUser,
  getBrokerConnectionStatus,
} from "../services/mcpTradingService";
import { requireMcpUserContext } from "../context/mcpContextStorage";

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function createTrustifyeeMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: mcpConfig.serverName,
      version: mcpConfig.serverVersion,
    },
    { capabilities: { logging: {} } }
  );

  server.registerTool(
    "get_system_health",
    {
      description: "Returns Trustifyee backend health: MongoDB, Redis, OMS, tick engine, risk engine.",
      inputSchema: {},
    },
    async () => jsonResult(await getSystemHealthSnapshot())
  );

  server.registerTool(
    "get_market_status",
    {
      description: "Returns NSE market open/closed status, session, and holiday info (IST).",
      inputSchema: {},
    },
    async () => jsonResult(getMarketStatusSnapshot())
  );

  server.registerTool(
    "get_observability_metrics",
    {
      description: "Returns observability metrics and active alerts from the monitoring stack.",
      inputSchema: {},
    },
    async () => jsonResult(getObservabilitySnapshot())
  );

  server.registerTool(
    "list_supported_brokers",
    {
      description:
        "Lists supported Indian brokers (Angel One, Alice Blue, Upstox, Zerodha). Note: Alice Blue is a broker, not Alice AI.",
      inputSchema: {},
    },
    async () => jsonResult(SUPPORTED_BROKERS)
  );

  server.registerTool(
    "get_user_profile",
    {
      description: "Returns authenticated user profile. Requires X-User-Token JWT header.",
      inputSchema: {},
    },
    async () => {
      const user = requireMcpUserContext();
      return jsonResult(await getUserProfileSnapshot(user.userId));
    }
  );

  server.registerTool(
    "get_broker_connection_status",
    {
      description: "Returns broker connection and trading status for the authenticated user.",
      inputSchema: {},
    },
    async () => {
      const user = requireMcpUserContext();
      return jsonResult(await getBrokerConnectionStatus(user.userId));
    }
  );

  server.registerTool(
    "get_open_positions",
    {
      description: "Returns open and recent positions for the authenticated user (max 50).",
      inputSchema: {},
    },
    async () => {
      const user = requireMcpUserContext();
      return jsonResult(await getOpenPositionsForUser(user));
    }
  );

  server.registerTool(
    "get_active_signals",
    {
      description: "Returns pending/active trading signals for the authenticated user.",
      inputSchema: {},
    },
    async () => {
      const user = requireMcpUserContext();
      return jsonResult(await getActiveSignalsForUser(user.userId));
    }
  );

  if (mcpConfig.enableTradeTools) {
    server.registerTool(
      "get_trade_api_info",
      {
        description:
          "Returns REST endpoints for trade execution. MCP does not execute trades directly — use the REST API with user JWT.",
        inputSchema: {},
      },
      async () =>
        jsonResult({
          note: "Trade execution via MCP is intentionally read-only. Use REST API.",
          endpoints: {
            queueExecution: "POST /api/signals/queue-execution",
            placeOrder: "POST /api/orders/place",
            closePosition: "POST /api/positions/close",
          },
          enableFullTradeTools: "Set MCP_ENABLE_TRADE_TOOLS=true only if extending MCP with custom tools",
        })
    );
  }

  server.registerResource(
    "system-health",
    "trustifyee://system/health",
    { mimeType: "application/json", description: "Live system health snapshot" },
    async () => ({
      contents: [
        {
          uri: "trustifyee://system/health",
          mimeType: "application/json",
          text: JSON.stringify(await getSystemHealthSnapshot(), null, 2),
        },
      ],
    })
  );

  server.registerResource(
    "supported-brokers",
    "trustifyee://brokers/supported",
    { mimeType: "application/json", description: "Supported broker integrations" },
    async () => ({
      contents: [
        {
          uri: "trustifyee://brokers/supported",
          mimeType: "application/json",
          text: JSON.stringify(SUPPORTED_BROKERS, null, 2),
        },
      ],
    })
  );

  server.registerPrompt(
    "trading-assistant",
    {
      description: "Prompt template for AI assistants operating on Trustifyee data",
      argsSchema: {
        task: z.string().describe("What the assistant should help with"),
      },
    },
    async ({ task }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are a Trustifyee trading platform assistant. Task: ${task}. Use MCP tools for read-only data. Never place orders unless explicitly authorized and MCP_ENABLE_TRADE_TOOLS is enabled.`,
          },
        },
      ],
    })
  );

  return server;
}
