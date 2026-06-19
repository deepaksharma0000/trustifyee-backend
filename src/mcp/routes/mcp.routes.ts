import { Router, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createTrustifyeeMcpServer } from "../server/createMcpServer";
import { mcpAuthMiddleware, McpAuthedRequest } from "../auth/mcpAuth.middleware";
import { mcpRateLimitMiddleware } from "../middleware/mcpRateLimit.middleware";
import { mcpContextStorage } from "../context/mcpContextStorage";
import { mcpConfig } from "../config/mcpConfig";
import log from "../../utils/logger";

const router = Router();

async function handleMcpRequest(req: McpAuthedRequest, res: Response): Promise<void> {
  const correlationId = String(req.header("x-correlation-id") || `mcp-${Date.now()}`);

  await mcpContextStorage.run(
    {
      auth: req.mcpAuth || { apiKeyValid: false },
      correlationId,
    },
    async () => {
      const server = createTrustifyeeMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);

        res.on("close", () => {
          transport.close().catch(() => undefined);
          server.close().catch(() => undefined);
        });
      } catch (error: any) {
        log.error("[MCP] Request handling failed", {
          correlationId,
          message: error?.message,
        });

        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal MCP server error" },
            id: null,
          });
        }
      }
    }
  );
}

router.get("/info", (_req, res) => {
  res.json({
    name: mcpConfig.serverName,
    version: mcpConfig.serverVersion,
    protocol: "MCP Streamable HTTP",
    transport: "POST (JSON-RPC), GET (SSE optional)",
    auth: {
      mode: mcpConfig.authMode,
      headers: {
        apiKey: "X-MCP-API-Key or Authorization: Bearer <MCP_API_KEY>",
        userToken: "X-User-Token (JWT for user-scoped tools)",
      },
    },
    tools: [
      "get_system_health",
      "get_market_status",
      "get_observability_metrics",
      "list_supported_brokers",
      "get_user_profile",
      "get_broker_connection_status",
      "get_open_positions",
      "get_active_signals",
    ],
    resources: ["trustifyee://system/health", "trustifyee://brokers/supported"],
    note: "Alice Blue in this project is the Indian stock broker. This is Model Context Protocol (MCP) for AI assistants.",
  });
});

router.post("/", mcpRateLimitMiddleware, mcpAuthMiddleware, handleMcpRequest);
router.post("", mcpRateLimitMiddleware, mcpAuthMiddleware, handleMcpRequest);

router.get("/", mcpRateLimitMiddleware, mcpAuthMiddleware, async (req: McpAuthedRequest, res) => {
  await handleMcpRequest(req, res);
});

router.delete("/", mcpRateLimitMiddleware, mcpAuthMiddleware, async (req: McpAuthedRequest, res) => {
  await handleMcpRequest(req, res);
});

export default router;
