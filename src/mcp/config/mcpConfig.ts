import dotenv from "dotenv";

dotenv.config();

export type McpAuthMode = "api_key" | "jwt" | "both";

export const mcpConfig = {
  enabled: process.env.MCP_ENABLED !== "false",
  nodeEnv: process.env.NODE_ENV || "development",
  serverName: process.env.MCP_SERVER_NAME || "trustifyee-mcp",
  serverVersion: process.env.MCP_SERVER_VERSION || "1.0.0",
  basePath: process.env.MCP_BASE_PATH || "/mcp",
  apiKey: process.env.MCP_API_KEY || "",
  authMode: (process.env.MCP_AUTH_MODE || "both") as McpAuthMode,
  enableTradeTools: process.env.MCP_ENABLE_TRADE_TOOLS === "true",
  rateLimitWindowMs: Number(process.env.MCP_RATE_LIMIT_WINDOW_MS || 60_000),
  rateLimitMaxRequests: Number(process.env.MCP_RATE_LIMIT_MAX || 120),
  standalonePort: Number(process.env.MCP_STANDALONE_PORT || 4100),
  corsOrigins: (process.env.MCP_CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

export function validateMcpConfig(): void {
  if (!mcpConfig.enabled) return;

  if (mcpConfig.nodeEnv === "production" && !mcpConfig.apiKey) {
    throw new Error("FATAL: MCP_API_KEY is required when MCP is enabled in production.");
  }

  if (mcpConfig.apiKey && mcpConfig.apiKey.length < 32) {
    throw new Error("FATAL: MCP_API_KEY must be at least 32 characters.");
  }

  if (!["api_key", "jwt", "both"].includes(mcpConfig.authMode)) {
    throw new Error("FATAL: MCP_AUTH_MODE must be api_key, jwt, or both.");
  }
}
