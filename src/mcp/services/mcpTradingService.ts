import User from "../../models/User";
import { Position } from "../../models/Position.model";
import { SignalService } from "../../services/SignalService";
import { McpUserContext } from "../types";

export async function getUserProfileSnapshot(userId: string) {
  const user = await User.findById(userId)
    .select("email broker broker_connected trading_status status licence end_date client_key")
    .lean();

  if (!user) {
    throw new Error("User not found");
  }

  return {
    userId: String(user._id),
    email: (user as any).email,
    broker: (user as any).broker,
    brokerConnected: Boolean((user as any).broker_connected),
    tradingStatus: (user as any).trading_status,
    accountStatus: (user as any).status,
    licence: (user as any).licence,
    licenceEndDate: (user as any).end_date,
  };
}

export async function getOpenPositionsForUser(user: McpUserContext) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const query: Record<string, unknown> = {
    userId: user.userId,
    $or: [
      { status: { $in: ["OPEN", "COMPLETE", "REJECTED"] } },
      { status: "CLOSED", updatedAt: { $gte: today } },
    ],
  };

  if (user.userType === "user") {
    query.createdAt = { $gte: today };
  }

  const positions = await Position.find(query).sort({ createdAt: -1 }).limit(50).lean();
  return positions.map((p: any) => ({
    id: String(p._id),
    tradingsymbol: p.tradingsymbol,
    exchange: p.exchange,
    quantity: p.quantity,
    side: p.side || p.transactiontype,
    status: p.status,
    entryPrice: p.entryPrice || p.averageprice,
    pnl: p.pnl,
    createdAt: p.createdAt,
  }));
}

export async function getActiveSignalsForUser(userId: string) {
  const signals = await SignalService.getActiveSignalsForUser(userId);
  return signals.map((s: any) => ({
    id: String(s._id || s.signalId),
    symbol: s.symbol || s.tradingsymbol,
    side: s.side || s.transactiontype,
    status: s.status,
    createdAt: s.createdAt,
  }));
}

export async function getBrokerConnectionStatus(userId: string) {
  const user = await User.findById(userId)
    .select("broker broker_connected trading_status status")
    .lean();

  if (!user) throw new Error("User not found");

  return {
    broker: (user as any).broker || "none",
    connected: Boolean((user as any).broker_connected),
    tradingEnabled: (user as any).trading_status === "enabled",
    accountActive: (user as any).status === "active",
  };
}
