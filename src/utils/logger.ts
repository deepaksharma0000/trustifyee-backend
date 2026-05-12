type LogLevel = "debug" | "info" | "warn" | "error";

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = (
  (process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"))
    .toLowerCase()
    .trim() as LogLevel
);
const minPriority = levelPriority[configuredLevel] ?? levelPriority.info;

const baseContext = {
  service: process.env.SERVICE_NAME || "trustifyee-backend",
  env: process.env.NODE_ENV || "development",
  pid: process.pid,
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const serializeError = (err: Error) => ({
  name: err.name,
  message: err.message,
  stack: err.stack,
});

const safeStringify = (payload: unknown) => {
  const seen = new WeakSet();
  return JSON.stringify(payload, (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Error) return serializeError(value);
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  });
};

const shouldLog = (level: LogLevel) => levelPriority[level] >= minPriority;

const normalizeArgs = (args: any[]) => {
  const messageParts: string[] = [];
  const detailParts: any[] = [];

  for (const arg of args) {
    if (typeof arg === "string") {
      messageParts.push(arg);
      continue;
    }
    if (arg instanceof Error) {
      detailParts.push({ error: serializeError(arg) });
      continue;
    }
    detailParts.push(arg);
  }

  const message = messageParts.join(" ").trim() || undefined;
  return { message, detailParts };
};

const createLogger = (context: Record<string, any> = {}) => {
  const emit = (level: LogLevel, ...args: any[]) => {
    if (!shouldLog(level)) return;

    const { message, detailParts } = normalizeArgs(args);
    const payload: Record<string, any> = {
      ts: new Date().toISOString(),
      level,
      ...baseContext,
      ...context,
    };

    if (message) payload.message = message;
    if (detailParts.length === 1) {
      payload.meta = detailParts[0];
    } else if (detailParts.length > 1) {
      payload.meta = detailParts;
    }

    const line = safeStringify(payload);
    if (level === "error") {
      process.stderr.write(line + "\n");
      return;
    }
    process.stdout.write(line + "\n");
  };

  return {
    debug: (...args: any[]) => emit("debug", ...args),
    info: (...args: any[]) => emit("info", ...args),
    warn: (...args: any[]) => emit("warn", ...args),
    error: (...args: any[]) => emit("error", ...args),
    child: (childContext: Record<string, any>) =>
      createLogger({
        ...context,
        ...(isObject(childContext) ? childContext : { childContext }),
      }),
  };
};

export const log = createLogger();
export default log;
