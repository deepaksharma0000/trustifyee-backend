import Redis from "ioredis";
import log from "./logger";

type BullRedisConnection = {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, unknown>;
  family?: number;
  maxRetriesPerRequest: null;
  enableReadyCheck: boolean;
  retryStrategy: (attempt: number) => number;
};

function buildRedisConfig(): BullRedisConnection {
  const fromUrl = process.env.REDIS_URL?.trim();

  if (fromUrl) {
    const parsed = new URL(fromUrl);
    const portFromUrl = Number(parsed.port || (parsed.protocol === "rediss:" ? 6380 : 6379));
    const dbFromPath = parsed.pathname ? Number(parsed.pathname.replace("/", "")) : undefined;

    return {
      host: parsed.hostname,
      port: Number.isFinite(portFromUrl) ? portFromUrl : 6379,
      username: parsed.username || undefined,
      password: parsed.password || undefined,
      db: Number.isFinite(dbFromPath as number) ? dbFromPath : undefined,
      tls: parsed.protocol === "rediss:" ? {} : undefined,
      family: 0,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: (attempt) => Math.min(attempt * 250, 5000),
    };
  }

  return {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT || 6379),
    family: 0,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (attempt) => Math.min(attempt * 250, 5000),
  };
}

export const redisBullConnection = buildRedisConfig();
export const redisConnection = new Redis(redisBullConnection as any);

redisConnection.on("connect", async () => {
  log.info("[REDIS] Connected", {
    host: redisBullConnection.host,
    port: redisBullConnection.port,
    db: redisBullConnection.db ?? 0,
    tls: Boolean(redisBullConnection.tls),
  });

  try {
    const info = await redisConnection.info("server");
    const versionMatch = info.match(/redis_version:(\S+)/);
    if (!versionMatch) return;

    const version = versionMatch[1];
    const [major, minor] = version.split(".").map(Number);
    if (major < 6 || (major === 6 && minor < 2)) {
      log.warn("[REDIS] BullMQ is best with Redis >= 6.2", { version });
    }
  } catch (err) {
    log.error("[REDIS] Failed to read server info", err);
  }
});

redisConnection.on("error", (err) => {
  log.error("[REDIS] Connection error", err);
});

export default redisConnection;
