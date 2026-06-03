/**
 * Verifies per-user Angel session isolation configuration.
 * Run: npx ts-node src/scripts/verifyBrokerIsolation.ts
 */
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import { config, validateConfig } from "../config";
import AngelTokensModel from "../models/AngelTokens";
import User from "../models/User";

type CheckResult = { name: string; ok: boolean; detail: string };

const checks: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
  const icon = ok ? "PASS" : "FAIL";
  console.log(`[${icon}] ${name}: ${detail}`);
}

async function main() {
  console.log("=== Trustifyee Broker Isolation Verification ===\n");

  try {
    validateConfig();
    record("validateConfig", true, "Production safety guards passed");
  } catch (e: any) {
    record("validateConfig", false, e.message);
  }

  record(
    "ALLOW_GLOBAL_SESSION_FALLBACK",
    process.env.ALLOW_GLOBAL_SESSION_FALLBACK !== "true",
    process.env.ALLOW_GLOBAL_SESSION_FALLBACK === "true"
      ? "ENABLED — will leak sessions across users"
      : "disabled (correct)"
  );

  record(
    "ALLOW_USERID_ONLY_SESSION_LOOKUP",
    process.env.ALLOW_USERID_ONLY_SESSION_LOOKUP !== "true",
    process.env.ALLOW_USERID_ONLY_SESSION_LOOKUP === "true"
      ? "ENABLED — may pick wrong clientCode JWT"
      : "disabled (correct)"
  );

  record(
    "FORCE_SHARED_VPS_ROUTE",
    config.forceSharedVpsRoute === true || config.nodeEnv !== "production",
    `forceSharedVpsRoute=${config.forceSharedVpsRoute}`
  );

  record(
    "PUBLIC_IP",
    Boolean(config.publicIp) || config.nodeEnv !== "production",
    config.publicIp || "not set"
  );

  await mongoose.connect(config.mongoUri);
  record("mongodb", true, "connected");

  const duplicateClientRows = await AngelTokensModel.aggregate([
    { $match: { clientcode: { $exists: true, $ne: "" } } },
    {
      $group: {
        _id: { userId: "$userId", clientcode: "$clientcode" },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $limit: 20 },
  ]);

  record(
    "duplicate_user_client_tokens",
    duplicateClientRows.length === 0,
    duplicateClientRows.length
      ? `${duplicateClientRows.length} duplicate userId+clientcode rows — consolidate AngelTokens`
      : "no duplicate userId+clientcode pairs"
  );

  const usersMissingTokens = await User.find({
    broker_connected: true,
    broker: { $regex: /^angelone$/i },
    status: "active",
  })
    .select("_id client_key")
    .lean();

  let missing = 0;
  for (const u of usersMissingTokens.slice(0, 50)) {
    const { decrypt } = await import("../utils/encryption");
    const cc = u.client_key ? decrypt(String(u.client_key)) : "";
    if (!cc) continue;
    const tok = await AngelTokensModel.findOne({
      userId: u._id,
      clientcode: cc,
      jwtToken: { $exists: true, $ne: "" },
    }).lean();
    if (!tok) missing += 1;
  }

  record(
    "active_users_have_scoped_tokens",
    missing === 0,
    missing
      ? `${missing} active Angel users (sampled) lack userId+clientcode JWT row`
      : "all sampled active users have scoped tokens"
  );

  await mongoose.disconnect();

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n=== Summary: ${checks.length - failed}/${checks.length} passed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
