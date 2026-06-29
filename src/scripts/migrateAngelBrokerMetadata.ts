import mongoose from "mongoose";
import User from "../models/User";
import AngelTokensModel from "../models/AngelTokens";
import { config } from "../config";
import { decrypt } from "../utils/encryption";
import { buildBrokerConnectionMetadata } from "../utils/apiKeyRouteBinding";
import log from "../utils/logger";

async function run() {
  await mongoose.connect(process.env.MONGO_URI || config.mongoUri);

  const users = await User.find({
    broker: { $regex: /^angelone$/i },
  })
    .select(
      "client_key api_key outgoing_ip assignedExecutionIp agent_url dedicated_ip_enabled api_key_ip_pair_verified " +
        "validated_api_key_fingerprint validated_route_ip validated_route_type validated_pair_at broker"
    )
    .lean();

  let updated = 0;

  for (const user of users as any[]) {
    if (!user.client_key) continue;

    const clientcode = decrypt(user.client_key);
    if (!clientcode) continue;

    const tokenDoc = await AngelTokensModel.findOne({
      userId: user._id,
      clientcode,
    }).lean();

    if (!tokenDoc) continue;

    const apiKeyPlain = user.api_key ? decrypt(user.api_key) : tokenDoc.apiKey ? decrypt(String(tokenDoc.apiKey)) : "";
    if (!apiKeyPlain) continue;

    const metadata = buildBrokerConnectionMetadata({
      brokerName: "Angel One",
      apiKey: apiKeyPlain,
      clientCode: clientcode,
      outgoingIp: user.outgoing_ip,
      assignedExecutionIp: user.assignedExecutionIp || user.outgoing_ip || user.validated_route_ip,
      agentUrl: user.agent_url,
      dedicatedIpEnabled: Boolean(user.dedicated_ip_enabled === true),
      verificationStatus: user.api_key_ip_pair_verified ? "VERIFIED" : "PENDING",
      connectionTimestamp: user.validated_pair_at
        ? new Date(user.validated_pair_at)
        : new Date((tokenDoc as any).updatedAt || Date.now()),
      brokerLoginTimestamp: user.validated_pair_at
        ? new Date(user.validated_pair_at)
        : new Date((tokenDoc as any).updatedAt || Date.now()),
    });

    await AngelTokensModel.updateOne(
      { _id: tokenDoc._id },
      {
        $set: {
          brokerName: tokenDoc.brokerName || metadata.brokerName,
          apiKeyFingerprint: tokenDoc.apiKeyFingerprint || metadata.apiKeyFingerprint,
          outgoingPublicIp: tokenDoc.outgoingPublicIp || metadata.outgoingPublicIp,
          registeredRouteIp: tokenDoc.registeredRouteIp || metadata.registeredRouteIp,
          routeType: tokenDoc.routeType || metadata.routeType,
          assignedExecutionIp: user.assignedExecutionIp || user.outgoing_ip || user.validated_route_ip || undefined,
          dedicatedIpEnabled:
            typeof tokenDoc.dedicatedIpEnabled === "boolean"
              ? tokenDoc.dedicatedIpEnabled
              : metadata.dedicatedIpEnabled,
          agentUrl: tokenDoc.agentUrl || metadata.agentUrl,
          brokerAppName: tokenDoc.brokerAppName || metadata.brokerAppName,
          connectionTimestamp: tokenDoc.connectionTimestamp || metadata.connectionTimestamp,
          verificationStatus: tokenDoc.verificationStatus || metadata.verificationStatus,
          brokerLoginTimestamp: tokenDoc.brokerLoginTimestamp || metadata.brokerLoginTimestamp,
        },
      }
    );

    updated += 1;
  }

  log.info("[MIGRATION] Angel broker metadata migration complete", {
    updated,
    totalUsers: users.length,
  });

  await mongoose.disconnect();
}

run().catch(async (err) => {
  log.error("[MIGRATION] Angel broker metadata migration failed", err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
