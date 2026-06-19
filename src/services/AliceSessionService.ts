import AliceTokensModel, { IAliceTokens } from "../models/AliceTokens";
import User from "../models/User";
import log from "../utils/logger";

export function normalizeAliceClientCode(value: string): string {
  return String(value || "").trim().toUpperCase();
}

export async function findAliceTokensForClient(
  clientcode: string,
  userId?: string
): Promise<IAliceTokens | null> {
  const normalized = normalizeAliceClientCode(clientcode);

  let doc =
    (await AliceTokensModel.findOne({ clientcode: normalized }).lean<IAliceTokens>()) ||
    (await AliceTokensModel.findOne({
      clientcode: { $regex: new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
    }).lean<IAliceTokens>());

  if (!doc && userId) {
    doc = await AliceTokensModel.findOne({ userId }).sort({ updatedAt: -1 }).lean<IAliceTokens>();
  }

  if (!doc?.sessionId) return null;

  if (doc.expiresAt && new Date(doc.expiresAt).getTime() <= Date.now()) {
    log.warn("[AliceSession] Session expired", { clientcode: normalized, userId });
    return null;
  }

  return doc;
}

export async function validateAliceSessionForUser(userId: string, clientcode: string): Promise<{
  ok: boolean;
  reason?: string;
}> {
  const tokens = await findAliceTokensForClient(clientcode, userId);
  if (!tokens?.sessionId) {
    return {
      ok: false,
      reason: "Alice Blue session missing. User must reconnect via Profile → Broker Connect.",
    };
  }
  if (tokens.expiresAt && new Date(tokens.expiresAt).getTime() <= Date.now()) {
    return {
      ok: false,
      reason: "Alice Blue session expired. User must reconnect via OAuth login.",
    };
  }
  return { ok: true };
}

export async function markAliceSessionExpired(clientcode: string, userId?: string): Promise<void> {
  const normalized = normalizeAliceClientCode(clientcode);
  await AliceTokensModel.deleteOne({
    $or: [{ clientcode: normalized }, ...(userId ? [{ userId }] : [])],
  });

  if (userId) {
    await User.updateOne(
      { _id: userId, broker: "AliceBlue" },
      { broker_connected: false, broker_verified: false }
    );
  }
}

export function computeAliceSessionExpiry(): Date {
  const expiry = new Date();
  expiry.setHours(23, 59, 59, 999);
  if (expiry.getTime() <= Date.now()) {
    expiry.setDate(expiry.getDate() + 1);
  }
  return expiry;
}
