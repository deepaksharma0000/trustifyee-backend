import { Request, Response, NextFunction } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import User from "../../models/User";
import Admin from "../../models/Admin";
import { mcpConfig } from "../config/mcpConfig";
import { McpRequestAuth } from "../types";
import log from "../../utils/logger";

const USER_ACCESS_SECRET = process.env.USER_ACCESS_SECRET || "user_access_secret_123";
const ADMIN_ACCESS_SECRET = process.env.ADMIN_ACCESS_SECRET || "admin_access_secret_123";

export interface McpAuthedRequest extends Request {
  mcpAuth?: McpRequestAuth;
}

function extractApiKey(req: Request): string {
  const headerKey = String(req.header("x-mcp-api-key") || "").trim();
  if (headerKey) return headerKey;

  const authHeader = String(req.header("authorization") || "").trim();
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  return "";
}

function extractUserToken(req: Request): string {
  const userToken = String(req.header("x-user-token") || req.header("x-access-token") || "").trim();
  if (userToken) return userToken;

  const authHeader = String(req.header("authorization") || "").trim();
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  return "";
}

async function resolveUserFromToken(token: string): Promise<McpRequestAuth["user"] | undefined> {
  if (!token) return undefined;

  try {
    const decoded = jwt.decode(token) as JwtPayload | null;
    if (!decoded?.user_id) return undefined;

    const role = decoded.role || "user";
    const secret =
      role === "admin" || role === "sub-admin" ? ADMIN_ACCESS_SECRET : USER_ACCESS_SECRET;
    const verified = jwt.verify(token, secret) as JwtPayload;

    if (role === "admin" || role === "sub-admin") {
      const admin = await Admin.findById(verified.user_id).lean();
      if (!admin) return undefined;
      return {
        userId: String(admin._id),
        userType: "admin",
        email: (admin as any).email,
      };
    }

    const user = await User.findById(verified.user_id).lean();
    if (!user || (user as any).status === "inactive") return undefined;

    return {
      userId: String(user._id),
      userType: "user",
      email: (user as any).email,
      broker: (user as any).broker,
      clientCode: (user as any).client_key ? "[encrypted]" : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function mcpAuthMiddleware(
  req: McpAuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!mcpConfig.enabled) {
    res.status(503).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "MCP server is disabled" },
      id: null,
    });
    return;
  }

  const apiKey = extractApiKey(req);
  const apiKeyValid =
    !mcpConfig.apiKey ||
    (apiKey.length > 0 && apiKey === mcpConfig.apiKey);

  const userToken = extractUserToken(req);
  const user = await resolveUserFromToken(userToken);

  const auth: McpRequestAuth = { apiKeyValid, user };

  if (mcpConfig.authMode === "api_key" && !apiKeyValid) {
    log.warn("[MCP] Unauthorized: invalid API key", { path: req.path });
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Invalid or missing MCP API key" },
      id: null,
    });
    return;
  }

  if (mcpConfig.authMode === "jwt" && !user) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Valid user JWT required" },
      id: null,
    });
    return;
  }

  if (mcpConfig.authMode === "both" && !apiKeyValid && !user) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "MCP API key or user JWT required" },
      id: null,
    });
    return;
  }

  req.mcpAuth = auth;
  next();
}

export function requireMcpUser(req: McpAuthedRequest): McpRequestAuth["user"] {
  if (!req.mcpAuth?.user) {
    throw new Error("User context required. Pass X-User-Token header with a valid JWT.");
  }
  return req.mcpAuth.user;
}
