// src/utils/logger.ts
export const log = {
  info: (...args: any[]) => console.log("[INFO]", ...args),
  debug: (...args: any[]) => { if (process.env.NODE_ENV !== "production") console.debug("[DEBUG]", ...args); },
  warn: (...args: any[]) => console.warn("[WARN]", ...args),
  error: (...args: any[]) => console.error("[ERROR]", ...args),
  child: (context: any) => {
    // Return a proxy to prepend context to logs (simplified child logger)
    return {
      info: (...args: any[]) => console.log("[INFO]", context, ...args),
      debug: (...args: any[]) => { if (process.env.NODE_ENV !== "production") console.debug("[DEBUG]", context, ...args); },
      warn: (...args: any[]) => console.warn("[WARN]", context, ...args),
      error: (...args: any[]) => console.error("[ERROR]", context, ...args),
      child: (newCtx: any) => log.child({ ...context, ...newCtx })
    };
  }
};

export default log;
