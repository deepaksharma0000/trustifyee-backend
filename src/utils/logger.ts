// src/utils/logger.ts
export const log = {
  info: (...args: any[]) => console.log("[INFO]", ...args),
  debug: (...args: any[]) => { if (process.env.NODE_ENV !== "production") console.debug("[DEBUG]", ...args); },
  warn: (...args: any[]) => console.warn("[WARN]", ...args),
  error: (...args: any[]) => console.error("[ERROR]", ...args)
};
