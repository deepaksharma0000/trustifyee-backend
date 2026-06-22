/**
 * Automated checks for Trustifyee Angel One go-live checklist (Steps 3–4, partial 7).
 *
 * Usage:
 *   npx ts-node scripts/go-live-verify.ts
 *   npx ts-node scripts/go-live-verify.ts --base-url https://trustifye.cloud --admin-token <jwt>
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import axios from "axios";
import { config, validateConfig } from "../src/config";
import { tickEngineService } from "../src/services/TickEngineService";
import AngelTokensModel from "../src/models/AngelTokens";
import User from "../src/models/User";
import { getSystemDataScopeUserId } from "../src/services/AngelAdapterRegistry";

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
  console.log("=== Trustifyee Angel One Go-Live Verification ===\n");

  // Step 3 — startup validation
  try {
    validateConfig();
    record("Step 3 — validateConfig", true, "System Data Isolation Validation Passed (no throw)");
  } catch (e: any) {
    record("Step 3 — validateConfig", false, e?.message || "validateConfig failed");
  }

  record(
    "Step 1 — SYSTEM_DATA_SCOPE_USER_ID",
    Boolean(String(config.systemDataScopeUserId || "").trim()),
    config.systemDataScopeUserId || "NOT SET"
  );

  await mongoose.connect(config.mongoUri);

  const dataUserId = getSystemDataScopeUserId();
  const dataClient = String(config.dataClientCode || "").trim();
  const dataToken = await AngelTokensModel.findOne({ userId: dataUserId, clientcode: dataClient }).lean();

  record(
    "Step 4 — scoped AngelTokens row",
    Boolean(dataToken),
    dataToken ? `userId=${dataUserId} clientcode=${dataClient}` : "Missing — run backend to let TickEngine create row"
  );

  const feed = tickEngineService.getSystemDataAuditSnapshot();
  record(
    "Step 4 — marketFeedStatus (local snapshot)",
    feed.marketFeedStatus === "CONNECTED" && feed.websocketConnected === true,
    `marketFeedStatus=${feed.marketFeedStatus} websocketConnected=${feed.websocketConnected} (TickEngine must be running in this process for live WS)`
  );

  if (adminToken) {
    try {
      const { data } = await axios.get(`${baseUrl}/api/admin/system-data-audit`, {
        headers: { Authorization: `Bearer ${adminToken}` },
        timeout: 15000,
      });
      record(
        "Step 4 — GET /api/admin/system-data-audit",
        data?.marketFeedStatus === "CONNECTED" && data?.websocketConnected === true,
        `marketFeedStatus=${data?.marketFeedStatus} websocketConnected=${data?.websocketConnected}`
      );
    } catch (e: any) {
      record("Step 4 — GET /api/admin/system-data-audit", false, e?.response?.data?.error || e?.message);
    }

    try {
      const { data } = await axios.get(`${baseUrl}/api/admin/angel-audit`, {
        headers: { Authorization: `Bearer ${adminToken}` },
        timeout: 30000,
      });
      const users = Array.isArray(data?.users) ? data.users : [];
      const connected = users.filter((u: any) => u.brokerConnected === true).length;
      const needsReconnect = users.filter((u: any) => u.requiresReconnect === true).length;
      record(
        "Step 7 — GET /api/admin/angel-audit",
        users.length === 0 || connected > 0,
        `${connected}/${users.length} brokerConnected, ${needsReconnect} requiresReconnect`
      );
    } catch (e: any) {
      record("Step 7 — GET /api/admin/angel-audit", false, e?.response?.data?.error || e?.message);
    }
  } else {
    record("Step 4/7 — admin HTTP checks", false, "Skipped — pass --admin-token or set GO_LIVE_ADMIN_TOKEN");
  }

  const tradersNeedingReconnect = await User.countDocuments({
    broker: { $regex: /^angelone$/i },
    requiresReconnect: true,
  });
  record(
    "Step 5 — migration (requiresReconnect)",
    tradersNeedingReconnect === 0,
    tradersNeedingReconnect === 0
      ? "No Angel traders flagged requiresReconnect"
      : `${tradersNeedingReconnect} trader(s) still require reconnect — run force-broker-reconnect or have users reconnect`
  );

  await mongoose.disconnect();

  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\n=== Result: ${rows.length - failed}/${rows.length} passed ===`);
  if (failed === 0) {
    console.log("System Approved For Production Trading (automated checks only — complete Steps 8–11 manually).");
  } else {
    console.log("Fix failing checks before production approval.");
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[go-live-verify] Failed:", err?.message || err);
  process.exit(1);
});
