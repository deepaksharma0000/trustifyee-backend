// src/services/SystemConfigManager.ts
import { SystemSetting } from "../models/SystemSetting";
import log from "../utils/logger";

export interface SystemFlags {
  PAPER_ONLY_MODE: boolean;
  LIVE_TRADING_ENABLED: boolean;
  SAFE_MODE_GLOBAL: boolean;
  BROKER_DISABLED: boolean;
  SHADOW_ONLY_MODE: boolean;
  EMERGENCY_KILL_SWITCH: boolean;
}

export class SystemConfigManager {
  private static instance: SystemConfigManager;
  
  private flags: SystemFlags = {
    PAPER_ONLY_MODE: process.env.PAPER_ONLY_MODE === "true" || false,
    LIVE_TRADING_ENABLED: process.env.LIVE_TRADING_ENABLED !== "false", // defaults to true
    SAFE_MODE_GLOBAL: process.env.SAFE_MODE_GLOBAL === "true" || false,
    BROKER_DISABLED: process.env.BROKER_DISABLED === "true" || false,
    SHADOW_ONLY_MODE: process.env.SHADOW_ONLY_MODE === "true" || false,
    EMERGENCY_KILL_SWITCH: process.env.EMERGENCY_KILL_SWITCH === "true" || false,
  };

  private constructor() {
    this.initialize();
  }

  public static getInstance(): SystemConfigManager {
    if (!SystemConfigManager.instance) {
      SystemConfigManager.instance = new SystemConfigManager();
    }
    return SystemConfigManager.instance;
  }

  /**
   * Initialize flags from the database. Falls back to environment variables.
   */
  public async initialize() {
    try {
      const dbSettings = await SystemSetting.find({
        key: { $in: Object.keys(this.flags) }
      }).lean();

      for (const setting of dbSettings) {
        if (setting.key in this.flags) {
          (this.flags as any)[setting.key] = setting.value === true || setting.value === "true";
        }
      }
      log.info("[SystemConfigManager] Initialized system operational flags successfully:", this.flags);
    } catch (err: any) {
      log.error("[SystemConfigManager] Failed initializing flags from DB, using memory defaults:", err.message);
    }
  }

  /**
   * Retrieves the current snapshot of all global feature flags.
   */
  public getSnapshot(): SystemFlags {
    return { ...this.flags };
  }

  /**
   * Updates an operational flag atomically in memory and persists to MongoDB.
   */
  public async updateFlag(key: keyof SystemFlags, value: boolean): Promise<boolean> {
    try {
      if (!(key in this.flags)) {
        throw new Error(`Invalid system config flag: ${key}`);
      }

      this.flags[key] = value;

      // Upsert in database
      await SystemSetting.findOneAndUpdate(
        { key },
        { $set: { value, description: `Global operational rollout status for ${key}` } },
        { upsert: true, new: true }
      );

      log.warn(`[SystemConfigManager] [ALERT_FLAG_CHANGE] Flag ${key} set to ${value}`);
      return true;
    } catch (err: any) {
      log.error(`[SystemConfigManager] Failed updating flag ${key} to ${value}:`, err.message);
      return false;
    }
  }

  /**
   * Custom helper to verify if entry orders are currently blocked.
   */
  public isEntryBlocked(): boolean {
    return this.flags.EMERGENCY_KILL_SWITCH || this.flags.SAFE_MODE_GLOBAL;
  }
}

export const systemConfigManager = SystemConfigManager.getInstance();
