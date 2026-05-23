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

const SENSITIVE_KEYS_SCRUB = new Set([
  "apikey", "apisecret", "jwttoken", "accesstoken", "refreshtoken", 
  "password", "totp", "totpsecret", "client_key", "encryptionkey", "secret", "appcode", "token"
]);

const SENSITIVE_KEYS_MASK = new Set([
  "email", "phone", "mobile", "pan", "aadhar", "dob", "address", "clientname", "username"
]);

const maskValue = (val: string): string => {
  if (!val || typeof val !== "string") return val;
  if (val.includes("@")) {
    const [local, domain] = val.split("@");
    return `${local[0]}***${local.slice(-1)}@${domain}`;
  }
  if (val.length <= 4) return "****";
  return `${val.slice(0, 2)}****${val.slice(-2)}`;
};

const sanitizePayload = (obj: any, seen = new WeakSet<object>(), depth = 0): any => {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (depth > 8) return "[TruncatedDepth]";
  if (seen.has(obj)) return "[Circular]";
  seen.add(obj);

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizePayload(item, seen, depth + 1));
  }

  const sanitized: Record<string, any> = {};
  for (const [key, val] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS_SCRUB.has(lowerKey)) {
      sanitized[key] = "[SCRUBBED]";
    } else if (SENSITIVE_KEYS_MASK.has(lowerKey)) {
      sanitized[key] = maskValue(String(val));
    } else if (typeof val === "object") {
      sanitized[key] = sanitizePayload(val, seen, depth + 1);
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
};

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

    const sanitized = sanitizePayload(payload);
    const line = safeStringify(sanitized);
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
