/**
 * Force all Angel One users to reconnect broker after per-user API key migration.
 *
 * Usage:
 *   npx ts-node scripts/force-broker-reconnect.ts
 *   npx ts-node scripts/force-broker-reconnect.ts --dry-run
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { config } from "../src/config";
import User from "../src/models/User";
import AngelTokensModel from "../src/models/AngelTokens";

dotenv.config();

const dryRun = process.argv.includes("--dry-run");

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log("[force-broker-reconnect] Connected to MongoDB");

  const filter = {
    $or: [{ broker: { $regex: /^angelone$/i } }, { broker_connected: true }],
  };

  const users = await User.find(filter).select("_id user_name email broker broker_connected").lean();
  console.log(`[force-broker-reconnect] Matched ${users.length} user(s)`);

  if (dryRun) {
    users.forEach((u) => {
      console.log(`  DRY-RUN would mark: ${u.user_name || u.email} (${u._id})`);
    });
    await mongoose.disconnect();
    return;
  }

  const userIds = users.map((u) => u._id);

  const userResult = await User.updateMany(filter, {
    $set: {
      requiresReconnect: true,
      broker_connected: false,
      broker_verified: false,
      api_key_ip_pair_verified: false,
      validated_api_key_fingerprint: null,
      validated_route_ip: null,
      validated_route_type: null,
      validated_pair_at: null,
    },
  });

  const tokenResult = await AngelTokensModel.deleteMany({
    userId: { $in: userIds },
  });

  console.log("[force-broker-reconnect] Users updated:", userResult.modifiedCount);
  console.log("[force-broker-reconnect] AngelTokens removed:", tokenResult.deletedCount);
  console.log("[force-broker-reconnect] Users must reconnect via Profile → Broker Connect.");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[force-broker-reconnect] Failed:", err);
  process.exit(1);
});
