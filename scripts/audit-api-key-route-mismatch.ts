/**
 * Audit API_KEY_ROUTE_MISMATCH for a client code.
 *
 * Usage:
 *   npx ts-node scripts/audit-api-key-route-mismatch.ts AACE741181
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { config } from "../src/config";
import User from "../src/models/User";
import AngelTokensModel from "../src/models/AngelTokens";
import { ensureEncrypted } from "../src/utils/encryption";
import { apiKeyFingerprint, buildApiKeyRouteBinding } from "../src/utils/apiKeyRouteBinding";
import { resolveConsistentApiKey } from "../src/services/BrokerSessionValidator";

dotenv.config();

const clientCodeArg = (process.argv[2] || "").trim().toUpperCase();
if (!clientCodeArg) {
  console.error("Usage: npx ts-node scripts/audit-api-key-route-mismatch.ts <CLIENT_CODE>");
  process.exit(1);
}

async function findUserByClientCode(target: string) {
  const candidates = await User.find({ client_key: { $exists: true, $ne: "" } })
    .select(
      "+api_key client_key user_name email broker broker_connected broker_verified requiresReconnect " +
        "api_key_ip_pair_verified validated_api_key_fingerprint validated_route_ip validated_route_type validated_pair_at " +
        "outgoing_ip agent_url dedicated_ip_enabled licence updatedAt createdAt"
    )
    .lean();

  for (const user of candidates) {
    try {
      const decrypted = await ensureEncrypted(user as any, "client_key", `audit_${user._id}`);
      if (String(decrypted || "").trim().toUpperCase() === target) {
        return user;
      }
    } catch {
      // skip
    }
  }

  const tokenHit = await AngelTokensModel.findOne({ clientcode: target }).lean();
  if (tokenHit?.userId) {
    return User.findById(tokenHit.userId)
      .select(
        "+api_key client_key user_name email broker broker_connected broker_verified requiresReconnect " +
          "api_key_ip_pair_verified validated_api_key_fingerprint validated_route_ip validated_route_type validated_pair_at " +
          "outgoing_ip agent_url dedicated_ip_enabled licence updatedAt createdAt"
      )
      .lean();
  }

  return null;
}

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log(`[audit] Connected. Client code: ${clientCodeArg}\n`);

  const user = await findUserByClientCode(clientCodeArg);
  if (!user) {
    console.error(`[audit] No user found for client code ${clientCodeArg}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const userId = String(user._id);
  const tokenDoc = await AngelTokensModel.findOne({ userId: user._id, clientcode: clientCodeArg }).lean();

  const resolution = await resolveConsistentApiKey({
    angelTokens: tokenDoc,
    profile: user,
    userId,
    clientcode: clientCodeArg,
  });

  const runtimeBinding = buildApiKeyRouteBinding(resolution.apiKey, {
    outgoingIp: (user as any).outgoing_ip,
    agentUrl: (user as any).agent_url,
    dedicatedIpEnabled: Boolean((user as any).dedicated_ip_enabled),
  });

  const platformFp = apiKeyFingerprint(config.angelApiKey || process.env.ANGEL_API_KEY || "");
  const dataFp = apiKeyFingerprint(config.dataApiKey || process.env.DATA_API_KEY || "");

  const expectedFp = String((user as any).validated_api_key_fingerprint || "").trim();
  const runtimeFp = runtimeBinding.apiKeyFingerprint;
  const match = expectedFp === runtimeFp;

  console.log("=== USER ===");
  console.log(JSON.stringify({
    userId,
    user_name: user.user_name,
    email: user.email,
    broker: user.broker,
    licence: user.licence,
    broker_connected: user.broker_connected,
    broker_verified: user.broker_verified,
    requiresReconnect: (user as any).requiresReconnect,
    api_key_ip_pair_verified: (user as any).api_key_ip_pair_verified,
    validated_pair_at: (user as any).validated_pair_at,
    updatedAt: (user as any).updatedAt,
    createdAt: (user as any).createdAt,
  }, null, 2));

  console.log("\n=== FINGERPRINT COMPARISON ===");
  console.log(JSON.stringify({
    expected_validated_api_key_fingerprint: expectedFp || "(empty)",
    runtime_binding_apiKeyFingerprint: runtimeFp,
    fingerprints_match: match,
    precheck_would_pass: match && Boolean((user as any).api_key_ip_pair_verified) && Boolean((user as any).validated_route_ip),
    strictPrecheck: process.env.STRICT_API_KEY_ROUTE_VALIDATION === "true",
  }, null, 2));

  console.log("\n=== API KEY RESOLUTION (OrderService runtime) ===");
  console.log(JSON.stringify({
    source: resolution.source,
    mismatchDetected: resolution.mismatchDetected,
    runtimeFingerprint: runtimeFp,
  }, null, 2));

  console.log("\n=== ROUTE BINDING ===");
  console.log(JSON.stringify({
    runtime: runtimeBinding,
    stored_validated_route_ip: (user as any).validated_route_ip || "(empty)",
    stored_validated_route_type: (user as any).validated_route_type || "(empty)",
    route_ip_match: String((user as any).validated_route_ip || "") === runtimeBinding.routeIp,
  }, null, 2));

  console.log("\n=== ANGEL TOKENS ===");
  if (!tokenDoc) {
    console.log("(no AngelTokens document)");
  } else {
    let tokenApiFp = "EMPTY";
    try {
      if (tokenDoc.apiKey) {
        tokenApiFp = apiKeyFingerprint(await ensureEncrypted(tokenDoc as any, "apiKey", `audit_token_${userId}`));
      }
    } catch {
      tokenApiFp = "DECRYPT_ERROR";
    }
    console.log(JSON.stringify({
      clientcode: tokenDoc.clientcode,
      token_api_key_fingerprint: tokenApiFp,
      jwtPresent: Boolean(tokenDoc.jwtToken),
      refreshPresent: Boolean(tokenDoc.refreshToken),
      expiresAt: tokenDoc.expiresAt,
      updatedAt: (tokenDoc as any).updatedAt,
      createdAt: (tokenDoc as any).createdAt,
    }, null, 2));
  }

  console.log("\n=== PLATFORM KEY REFERENCE (migration check) ===");
  console.log(JSON.stringify({
    USE_PLATFORM_ANGEL_API_KEY: process.env.USE_PLATFORM_ANGEL_API_KEY,
    platform_ANGEL_API_KEY_fingerprint: platformFp,
    DATA_API_KEY_fingerprint: dataFp,
    likely_platform_era_fingerprint: expectedFp === platformFp && expectedFp !== runtimeFp,
  }, null, 2));

  if (!match) {
    console.log("\n=== REMEDIATION ===");
    console.log("1. User must reconnect: Dashboard → Broker Connect with THEIR SmartAPI Private Key + TOTP secret.");
    console.log("2. Or admin: npx ts-node scripts/force-broker-reconnect.ts (all users) then user reconnects.");
    console.log("3. After reconnect, re-run this script — expected and runtime fingerprints must match.");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[audit] Failed:", err?.message || err);
  process.exit(1);
});
