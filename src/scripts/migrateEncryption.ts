import mongoose from "mongoose";
import { config } from "../config";
import User from "../models/User";
import AngelTokens from "../models/AngelTokens";
import { encrypt, isMigrated, safeDecrypt } from "../utils/encryption";
import { log } from "../utils/logger";

async function migrate() {
  let stats = {
      users: { migrated: 0, skipped: 0, failed: 0, failedIds: [] as string[] },
      tokens: { migrated: 0, skipped: 0, failed: 0, failedIds: [] as string[] }
  };

  try {
    log.info("Starting STRICT ZERO-DATA-LOSS encryption migration...");
    await mongoose.connect(config.mongoUri);
    log.info("Connected to MongoDB");

    // 1. Migrate Users
    const users = await User.find({});
    log.info(`Checking ${users.length} users...`);

    for (const user of users) {
      let changed = false;
      const fieldsToMigrate: (keyof any)[] = ["api_key", "broker_totp_secret", "broker_password", "client_key"];
      
      for (const field of fieldsToMigrate) {
        const value = (user as any)[field];
        if (value && !isMigrated(value)) {
          const plaintext = safeDecrypt(value, `user_${user.user_name}_${String(field)}`);
          
          if (!plaintext || plaintext.length < 3) {
             log.error(`[MIGRATION_FAILED] User: ${user.user_name} | Field: ${field} - Invalid plaintext.`);
             stats.users.failed++;
             stats.users.failedIds.push(`${user.user_name}:${field}`);
             continue;
          }

          log.info(`Migrating ${String(field)} for user: ${user.user_name}`);
          (user as any)[field] = encrypt(plaintext);
          changed = true;
          stats.users.migrated++;
        } else {
          stats.users.skipped++;
        }
      }

      if (changed) {
        await user.save();
      }
    }

    // 2. Migrate AngelTokens
    const tokens = await AngelTokens.find({});
    log.info(`Checking ${tokens.length} AngelToken records...`);

    for (const token of tokens) {
      let changed = false;
      const fieldsToMigrate: (keyof any)[] = ["jwtToken", "refreshToken", "feedToken", "apiKey"];

      for (const field of fieldsToMigrate) {
        const value = (token as any)[field];
        if (value && !isMigrated(value)) {
          const plaintext = safeDecrypt(value, `tokens_${token.clientcode}_${String(field)}`);
          
          if (!plaintext || plaintext.length < 5) {
             log.error(`[MIGRATION_FAILED] Token: ${token.clientcode} | Field: ${field} - Invalid plaintext.`);
             stats.tokens.failed++;
             stats.tokens.failedIds.push(`${token.clientcode}:${field}`);
             continue;
          }

          log.info(`Migrating ${String(field)} for clientcode: ${token.clientcode}`);
          (token as any)[field] = encrypt(plaintext);
          changed = true;
          stats.tokens.migrated++;
        } else {
          stats.tokens.skipped++;
        }
      }

      if (changed) {
        await token.save();
      }
    }

    log.info("------------------------------------------");
    log.info("MIGRATION SUMMARY:");
    log.info(`USERS  | Migrated: ${stats.users.migrated} | Skipped: ${stats.users.skipped} | Failed: ${stats.users.failed}`);
    log.info(`TOKENS | Migrated: ${stats.tokens.migrated} | Skipped: ${stats.tokens.skipped} | Failed: ${stats.tokens.failed}`);
    
    if (stats.users.failed > 0) log.warn(`Failed User Fields: ${stats.users.failedIds.join(", ")}`);
    if (stats.tokens.failed > 0) log.warn(`Failed Token Fields: ${stats.tokens.failedIds.join(", ")}`);
    log.info("------------------------------------------");

    process.exit(0);
  } catch (err) {
    log.error("Migration CRITICAL failure:", err);
    process.exit(1);
  }
}

migrate();
