// src/services/SignalService.ts
// FIX #1 (Signal Push) + FIX #7 (Duplicate prevention)
import { Signal } from "../models/Signal";
import { SignalExecutionResult } from "../models/SignalExecutionResult";
import User from "../models/User";
import log from "../utils/logger";
import { broadcastToAllUsers, broadcastToUser } from "./UserSocketService";

export class SignalService {
  /**
   * Create a trade signal and immediately push it to all connected users
   * via the /ws/signals WebSocket channel.
   *
   * FIX #7: Signals are idempotent per (tradingsymbol + side + strategy + ~1min window)
   * to prevent duplicate signals from rapid algo engine loops.
   */
  static async createSignal(tradeData: {
    symbol: string;
    exchange: string;
    side: "BUY" | "SELL";
    tradingsymbol: string;
    strike?: number;
    optiontype?: "CE" | "PE";
    expiry?: Date;
    price: number;
    quantity: number;
    strategy?: string;
    adminOrderId?: string;
    signalType: "ENTRY" | "EXIT";
    executionMode?: "SERVER" | "CLIENT"; // [NEW] Distinguish execution source
  }) {
    try {
      // ── FIX #7: Dedup check — prevent creating identical signal twice in 60s ──
      const oneMinAgo = new Date(Date.now() - 60_000);
      const existingSignal = await Signal.findOne({
        tradingsymbol: tradeData.tradingsymbol,
        side: tradeData.side,
        strategy: tradeData.strategy,
        signalType: tradeData.signalType,
        status: "ACTIVE",
        createdAt: { $gte: oneMinAgo },
      }).lean();

      if (existingSignal) {
        log.warn(
          `[SignalService] Duplicate signal suppressed: ${tradeData.tradingsymbol} (${tradeData.side}) within 60s window`
        );
        return existingSignal;
      }

      const signal = await Signal.create({
        ...tradeData,
        status: "ACTIVE",
      });

      log.info(
        `[SignalService] Signal created: ${signal.tradingsymbol} (${signal.side}) - ID: ${signal._id}`
      );

      // ── FIX #1: PUSH to all connected users via WebSocket ──────────────────
      const pushed = broadcastToAllUsers({
        type: "TRADE_SIGNAL",
        data: {
          signalId: signal._id,
          symbol: signal.symbol,
          exchange: signal.exchange,
          tradingsymbol: signal.tradingsymbol,
          side: signal.side,
          strike: signal.strike,
          optiontype: signal.optiontype,
          expiry: signal.expiry,
          price: signal.price,
          quantity: signal.quantity,
          strategy: signal.strategy,
          signalType: signal.signalType,
          executionMode: signal.executionMode || 'CLIENT', // Default to client if not specified
          createdAt: (signal as any).createdAt,
        },
      });

      log.info(`[SignalService] Signal pushed to ${pushed} connected users via WebSocket`);

      return signal;
    } catch (error) {
      log.error("[SignalService] Error creating signal:", error);
      throw error;
    }
  }

  /**
   * Get active signals for a specific user.
   * Used as HTTP fallback when WebSocket is not connected (FIX #9).
   */
  static async getActiveSignalsForUser(userId: string) {
    const user = await User.findById(userId).lean();
    if (!user) return [];

    // Return only ACTIVE signals not yet executed by this user
    const executedSignalIds = await SignalExecutionResult.distinct("signalId", {
      userId,
      status: "SUCCESS",
    });

    const signals = await Signal.find({
      status: "ACTIVE",
      _id: { $nin: executedSignalIds },
    })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    return signals;
  }

  /**
   * Mark a signal as expired (called by a scheduled cleanup job or on EOD).
   */
  static async expireOldSignals(olderThanMinutes = 30) {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
    const result = await Signal.updateMany(
      { status: "ACTIVE", createdAt: { $lt: cutoff } },
      { $set: { status: "EXPIRED" } }
    );
    if (result.modifiedCount > 0) {
      log.info(`[SignalService] Expired ${result.modifiedCount} stale signals`);
    }
  }
}
