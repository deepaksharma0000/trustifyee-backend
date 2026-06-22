/**
 * Resolve SYSTEM_DATA_SCOPE_USER_ID for Step 1 of go-live checklist.
 *
 * Finds Admin/User whose client_key matches DATA_CLIENT_CODE.
 * Does NOT modify .env — prints the value to set manually.
 *
 * Usage:
 *   npx ts-node scripts/resolve-system-data-scope-user-id.ts
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { config } from "../src/config";
import User from "../src/models/User";
import Admin from "../src/models/Admin";
import { decrypt } from "../src/utils/encryption";

dotenv.config();

async function main() {
  const targetClient = String(config.dataClientCode || process.env.DATA_CLIENT_CODE || "").trim().toUpperCase();
  if (!targetClient) {
    console.error("FATAL: DATA_CLIENT_CODE is not set in .env");
    process.exit(1);
  }

  await mongoose.connect(config.mongoUri);
  console.log(`[resolve-data-scope] Connected. Looking for client code: ${targetClient}\n`);

  const users = await User.find({})
    .select("_id user_name email client_key broker")
    .lean();

  for (const u of users) {
    let client = "";
    try {
      if (u.client_key) client = decrypt(String(u.client_key)).trim().toUpperCase();
    } catch {
      /* skip */
    }
    if (client === targetClient) {
      console.log("MATCH (User collection):");
      console.log(`  SYSTEM_DATA_SCOPE_USER_ID=${u._id}`);
      console.log(`  user_name: ${(u as any).user_name || "—"}`);
      console.log(`  email: ${(u as any).email || "—"}`);
      console.log(`  broker: ${(u as any).broker || "—"}`);
      console.log("\nAdd the line above to trustifyee-backend/.env then restart.");
      await mongoose.disconnect();
      return;
    }
  }

  const admins = await Admin.find({})
    .select("_id user_name email client_key panel_client_key")
    .lean();

  for (const a of admins) {
    const candidates: string[] = [];
    try {
      if (a.client_key) candidates.push(decrypt(String(a.client_key)).trim().toUpperCase());
      if ((a as any).panel_client_key) {
        candidates.push(decrypt(String((a as any).panel_client_key)).trim().toUpperCase());
      }
    } catch {
      /* skip */
    }
    if (candidates.includes(targetClient)) {
      console.log("MATCH (Admin collection):");
      console.log(`  SYSTEM_DATA_SCOPE_USER_ID=${a._id}`);
      console.log(`  user_name: ${(a as any).user_name || "—"}`);
      console.log("\nAdd the line above to trustifyee-backend/.env then restart.");
      await mongoose.disconnect();
      return;
    }
  }

  console.error(`No User/Admin found with client_key matching DATA_CLIENT_CODE=${targetClient}.`);
  console.error("Create a dedicated market-data Admin/User with that client code, then re-run this script.");
  await mongoose.disconnect();
  process.exit(1);
}

main().catch((err) => {
  console.error("[resolve-data-scope] Failed:", err?.message || err);
  process.exit(1);
});
