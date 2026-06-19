import { Request, Response, NextFunction } from "express";
import { mcpConfig } from "../config/mcpConfig";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

function clientKey(req: Request): string {
  const forwarded = String(req.header("x-forwarded-for") || "").split(",")[0]?.trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

export function mcpRateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const key = clientKey(req);
  const now = Date.now();
  const windowMs = mcpConfig.rateLimitWindowMs;
  const max = mcpConfig.rateLimitMaxRequests;

  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }

  bucket.count += 1;

  res.setHeader("X-RateLimit-Limit", String(max));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > max) {
    res.status(429).json({
      jsonrpc: "2.0",
      error: { code: -32029, message: "MCP rate limit exceeded" },
      id: null,
    });
    return;
  }

  next();
}

// Prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}, 60_000).unref();
