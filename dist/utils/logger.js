"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = void 0;
// src/utils/logger.ts
exports.log = {
    info: (...args) => console.log("[INFO]", ...args),
    debug: (...args) => { if (process.env.NODE_ENV !== "production")
        console.debug("[DEBUG]", ...args); },
    warn: (...args) => console.warn("[WARN]", ...args),
    error: (...args) => console.error("[ERROR]", ...args)
};
