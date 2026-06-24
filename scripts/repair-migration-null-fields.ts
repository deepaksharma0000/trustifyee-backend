/**
 * Repair User documents where force-broker-reconnect wrote null into enum fields.
 * Null fails Mongoose validation on login (validated_route_type enum).
 *
 * Usage:
 *   npx ts-node scripts/repair-migration-null-fields.ts
 *   npx ts-node scripts/repair-migration-null-fields.ts --dry-run
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { config } from "../src/config";
import User from "../src/models/User";

dotenv.config();

const dryRun = process.argv.includes("--dry-run");

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log("[repair-migration-null-fields] Connected to MongoDB");

  const filter = {
    $or: [
      { validated_route_type: null },
      { validated_route_ip: null },
      { validated_api_key_fingerprint: null },
      { validated_pair_at: null },
    ],
  };

  const count = await User.countDocuments(filter);
  console.log(`[repair-migration-null-fields] Users with null validation fields: ${count}`);

  if (count === 0) {
    console.log("[repair-migration-null-fields] Nothing to repair.");
    await mongoose.disconnect();
    return;
  }

  if (dryRun) {
    const sample = await User.find(filter).select("user_name email validated_route_type").limit(10).lean();
    sample.forEach((u) => console.log(`  DRY-RUN: ${u.email || u.user_name} validated_route_type=${(u as any).validated_route_type}`));
    await mongoose.disconnect();
    return;
  }

  const result = await User.updateMany(filter, {
    $unset: {
      validated_api_key_fingerprint: "",
      validated_route_ip: "",
      validated_route_type: "",
      validated_pair_at: "",
    },
  });

  console.log("[repair-migration-null-fields] Users repaired:", result.modifiedCount);
  console.log("[repair-migration-null-fields] Users can log in again. They still must reconnect broker.");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[repair-migration-null-fields] Failed:", err);
  process.exit(1);
});
