// src/utils/logger.ts
export const log = {
  info: (...args: any[]) => console.log("[INFO]", ...args),
  debug: (...args: any[]) => { if (process.env.NODE_ENV !== "production") console.debug("[DEBUG]", ...args); },
  error: (...args: any[]) => console.error("[ERROR]", ...args)
};
