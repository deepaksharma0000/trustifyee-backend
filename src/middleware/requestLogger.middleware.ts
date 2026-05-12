import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import log from "../utils/logger";

const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "x-access-token"]);

function sanitizeHeaders(headers: Record<string, any>) {
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      sanitized[key] = "[REDACTED]";
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const incomingCorrelation = (req.headers["x-correlation-id"] as string) || "";
  const correlationId = incomingCorrelation.trim() || randomUUID();

  (req as any).correlationId = correlationId;
  res.setHeader("x-correlation-id", correlationId);

  const startedAt = Date.now();
  const logger = log.child({ correlationId, requestId: correlationId, path: req.path, method: req.method });

  logger.info("HTTP request started", {
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    headers: sanitizeHeaders(req.headers as Record<string, any>),
  });

  res.on("finish", () => {
    logger.info("HTTP request completed", {
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  next();
};
