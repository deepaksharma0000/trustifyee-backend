/**
 * Automated production go-live validation.
 *
 * Usage:
 *   npx ts-node scripts/go-live-verify.ts
 *   npx ts-node scripts/go-live-verify.ts --base-url https://trustifye.cloud --admin-token <jwt>
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import axios from "axios";
import { config, validateConfig } from "../src/config";
import { runProductionGoLiveValidation } from "../src/services/ProductionGoLiveValidator";

dotenv.config();

type Row = { step: string; ok: boolean; detail: string };

const rows: Row[] = [];
const args = process.argv.slice(2);
const baseUrlIdx = args.indexOf("--base-url");
const tokenIdx = args.indexOf("--admin-token");
const baseUrl = baseUrlIdx >= 0 ? args[baseUrlIdx + 1] : `http://127.0.0.1:${config.port}`;
const adminToken = tokenIdx >= 0 ? args[tokenIdx + 1] : process.env.GO_LIVE_ADMIN_TOKEN || "";

function record(step: string, ok: boolean, detail: string) {
  rows.push({ step, ok, detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${step}: ${detail}`);
}

async function main() {
  console.log("=== Trustifyee Angel One Production Go-Live Verification ===\n");

  try {
    validateConfig();
    record("validateConfig", true, "System Data Isolation Validation Passed");
  } catch (e: any) {
    record("validateConfig", false, e?.message || "validateConfig failed");
  }

  await mongoose.connect(config.mongoUri);

  const report = await runProductionGoLiveValidation();

  record(
    "code — shouldUsePlatformAngelApiKey=false",
    report.codeInvariants.shouldUsePlatformAngelApiKeyAlwaysFalse === true,
    "platformAngelApiKey.ts — user trading never uses platform key"
  );

  record(
    "code — perUserApiKeyMode",
    report.perUserApiKeyMode && !report.platformKeyForUserTrading,
    `perUserApiKeyMode=${report.perUserApiKeyMode} platformKeyForUserTrading=${report.platformKeyForUserTrading}`
  );

  record(
    "config — PUBLIC_IP",
    Boolean(report.serverEgressIp),
    report.serverEgressIp || "NOT SET"
  );

  record(
    "users — live ready for trading",
    report.userSummary.liveConnected === 0 || report.userSummary.readyForTrading === report.userSummary.liveConnected,
    `${report.userSummary.readyForTrading}/${report.userSummary.liveConnected} connected Live users pass all prechecks`
  );

  record(
    "users — fingerprint mismatch",
    report.userSummary.fingerprintMismatch === 0,
    report.userSummary.fingerprintMismatch === 0
      ? "No fingerprint mismatches"
      : `${report.userSummary.fingerprintMismatch} user(s) — run audit-api-key-route-mismatch.ts`
  );

  record(
    "users — requiresReconnect",
    report.userSummary.requiresReconnect === 0 || report.userSummary.migrationPendingReconnect === report.userSummary.requiresReconnect,
    report.userSummary.requiresReconnect === 0
      ? "No users flagged requiresReconnect"
      : report.userSummary.migrationPendingReconnect === report.userSummary.requiresReconnect
      ? `${report.userSummary.requiresReconnect} user(s) pending reconnect after migration (expected — notify users to use Broker Connect)`
      : `${report.userSummary.requiresReconnect} user(s) — investigate requiresReconnect with broker_connected=true`
  );

  record(
    "users — platform-era fingerprint",
    report.userSummary.likelyPlatformEra === 0,
    report.userSummary.likelyPlatformEra === 0
      ? "No legacy platform-key fingerprints"
      : `${report.userSummary.likelyPlatformEra} user(s) need broker reconnect`
  );

  record(
    "capacity — one VPS IP multi-user",
    report.capacity.oneVpsIpMultiUser === true,
    `serverEgressIp=${report.serverEgressIp} perUserSmartApiApps=${report.capacity.perUserSmartApiApps}`
  );

  console.log(`\n--- Production Readiness Score: ${report.productionReadinessScore}/100 ---`);
  console.log(`--- Approval Status: ${report.approvalStatus} ---\n`);

  if (report.blockers.length) {
    console.log("Blockers:");
    report.blockers.forEach((b) => console.log(`  - ${b}`));
  }
  if (report.requiredAdminActions.length) {
    console.log("\nRequired admin actions:");
    report.requiredAdminActions.forEach((a) => console.log(`  - ${a}`));
  }
  if (report.requiredUserActions.length) {
    console.log("\nRequired user actions:");
    report.requiredUserActions.slice(0, 20).forEach((a) => console.log(`  - ${a}`));
    if (report.requiredUserActions.length > 20) {
      console.log(`  ... and ${report.requiredUserActions.length - 20} more`);
    }
  }

  if (adminToken) {
    try {
      const { data } = await axios.get(`${baseUrl}/api/admin/production-readiness`, {
        headers: { Authorization: `Bearer ${adminToken}` },
        timeout: 60000,
      });
      record(
        "HTTP — GET /api/admin/production-readiness",
        data?.approvalStatus === "APPROVED" || data?.approvalStatus === "CONDITIONAL",
        `score=${data?.productionReadinessScore} status=${data?.approvalStatus}`
      );
    } catch (e: any) {
      record("HTTP — GET /api/admin/production-readiness", false, e?.response?.data?.error || e?.message);
    }
  } else {
    record(
      "HTTP — admin API",
      false,
      "Skipped — export ADMIN_JWT='eyJ...' (admin login token) then re-run with --admin-token \"$ADMIN_JWT\""
    );
  }

  await mongoose.disconnect();

  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\n=== Result: ${rows.length - failed}/${rows.length} checks passed ===`);
  process.exit(failed > 0 || report.approvalStatus === "BLOCKED" ? 1 : 0);
}

main().catch((err) => {
  console.error("[go-live-verify] Failed:", err?.message || err);
  process.exit(1);
});
