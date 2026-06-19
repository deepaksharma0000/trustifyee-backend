import { AsyncLocalStorage } from "async_hooks";
import { McpRequestAuth } from "../types";

export type McpRuntimeContext = {
  auth: McpRequestAuth;
  correlationId?: string;
};

export const mcpContextStorage = new AsyncLocalStorage<McpRuntimeContext>();

export function getMcpContext(): McpRuntimeContext | undefined {
  return mcpContextStorage.getStore();
}

export function requireMcpUserContext() {
  const ctx = getMcpContext();
  if (!ctx?.auth?.user) {
    throw new Error("User context required. Include X-User-Token header with a valid JWT.");
  }
  return ctx.auth.user;
}
