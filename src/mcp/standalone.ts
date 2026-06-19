/**
 * Standalone MCP server — stdio transport for Claude Desktop / Cursor.
 *
 * Run: npm run mcp:stdio
 * Configure in Cursor/Claude:
 *   { "command": "node", "args": ["dist/mcp/standalone.js"], "cwd": "/path/to/trustifyee-backend" }
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTrustifyeeMcpServer } from "./server/createMcpServer";
import { mcpConfig, validateMcpConfig } from "./config/mcpConfig";
import { config, validateConfig } from "../config";
import log from "../utils/logger";

dotenv.config();

async function main(): Promise<void> {
  validateConfig();
  validateMcpConfig();

  if (config.mongoUri) {
    await mongoose.connect(config.mongoUri);
    log.info("[MCP:stdio] MongoDB connected");
  }

  const server = createTrustifyeeMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info("[MCP:stdio] Server running", {
    name: mcpConfig.serverName,
    version: mcpConfig.serverVersion,
  });

  const shutdown = async () => {
    await server.close();
    await mongoose.disconnect().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("[MCP:stdio] Fatal error", err);
  process.exit(1);
});
