import User from "../models/User";
import { decrypt } from "./encryption";

export async function findUserByClientCode(clientcode: string) {
  const cleanClientCode = String(clientcode || "").trim();
  if (!cleanClientCode) return null;

  // Fast path for legacy plaintext records.
  let user = await User.findOne({ client_key: cleanClientCode });
  if (user) return user;

  const candidates = await User.find({ client_key: { $exists: true, $ne: "" } })
    .select("client_key")
    .lean() as any[];

  const matched = candidates.find((doc) => decrypt(doc.client_key || "") === cleanClientCode);
  if (!matched?._id) return null;

  user = await User.findById(matched._id);
  return user;
}
