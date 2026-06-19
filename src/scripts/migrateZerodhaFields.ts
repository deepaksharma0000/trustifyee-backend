/**
 * Migration: initialize Zerodha fields on existing User documents.
 *
 * Usage:
 *   npx ts-node src/scripts/migrateZerodhaFields.ts
 */
import mongoose from "mongoose";
import { config } from "../config";
import User from "../models/User";
import { encrypt, isMigrated } from "../utils/encryption";
import log from "../utils/logger";

async function migrateZerodhaFields() {
  const stats = {
    scanned: 0,
    initialized: 0,
    encrypted: 0,
    skipped: 0,
    failed: 0,
  };

  await mongoose.connect(config.mongoUri);
  log.info("[ZERODHA_MIGRATION] Connected to MongoDB");

  const users = await User.find({});
  stats.scanned = users.length;

  for (const user of users) {
    try {
      let changed = false;
      const update: Record<string, any> = {};

      if (user.zerodha_connected === undefined) {
        update.zerodha_connected = false;
        changed = true;
      }
      if (user.zerodha_verified === undefined) {
        update.zerodha_verified = false;
        changed = true;
      }

      const sensitiveFields = [
        "zerodha_api_key",
        "zerodha_api_secret",
        "zerodha_request_token",
        "zerodha_access_token",
        "zerodha_refresh_token",
      ] as const;

      for (const field of sensitiveFields) {
        const value = (user as any)[field];
        if (value && !isMigrated(value)) {
          update[field] = encrypt(String(value));
          stats.encrypted += 1;
          changed = true;
        }
      }

      if (changed) {
        await User.updateOne({ _id: user._id }, { $set: update });
        stats.initialized += 1;
      } else {
        stats.skipped += 1;
      }
    } catch (err: any) {
      stats.failed += 1;
      log.error("[ZERODHA_MIGRATION] Failed for user", {
        userId: String(user._id),
        message: err?.message,
      });
    }
  }

  log.info("[ZERODHA_MIGRATION] Complete", stats);
  await mongoose.disconnect();
}

migrateZerodhaFields().catch((err) => {
  log.error("[ZERODHA_MIGRATION] Fatal error", err);
  process.exit(1);
});
