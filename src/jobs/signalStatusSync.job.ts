import User from "../models/User";
import { SignalExecutionResult } from "../models/SignalExecutionResult";
import { fetchBrokerOrder } from "../services/OrderService";
import { broadcastToUser } from "../services/UserSocketService";
import { decrypt } from "../utils/encryption";
import log from "../utils/logger";

const SYNC_BATCH_SIZE = Math.max(10, Number(process.env.SIGNAL_STATUS_SYNC_BATCH || "60"));
const LOOKBACK_HOURS = Math.max(1, Number(process.env.SIGNAL_STATUS_SYNC_LOOKBACK_HOURS || "24"));

const normalizeBrokerOrderStatus = (payload: any): string => {
  const raw =
    payload?.orderstatus ||
    payload?.status ||
    payload?.orderStatus ||
    payload?.order_state ||
    payload?.orderstate ||
    "";
  return String(raw || "").trim().toUpperCase();
};

const isRejectedStatus = (status: string) => {
  const s = String(status || "").toUpperCase();
  return s === "REJECTED" || s === "CANCELLED" || s === "CANCELED" || s === "FAILED";
};

const isAcceptedStatus = (status: string) => {
  const s = String(status || "").toUpperCase();
  return s === "OPEN" || s === "COMPLETE" || s === "PARTIALLY FILLED";
};

const isPendingStatus = (status: string) => {
  const s = String(status || "").toUpperCase();
  return (
    s === "" ||
    s === "PENDING" ||
    s === "TRIGGER PENDING" ||
    s === "VALIDATION PENDING" ||
    s === "PUT ORDER REQ RECEIVED"
  );
};

const extractRejectReason = (payload: any): string => {
  return String(
    payload?.text ||
      payload?.rejectreason ||
      payload?.rejreason ||
      payload?.reason ||
      payload?.message ||
      payload?.statusmessage ||
      "Order rejected by broker"
  ).trim();
};

export const syncSignalExecutionStatuses = async () => {
  const lookback = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);
  const rows = await SignalExecutionResult.find({
    broker: { $regex: /^angelone$/i },
    orderId: { $exists: true, $ne: "", $not: /^PAPER-/i },
    status: { $in: ["PENDING", "QUEUED", "SUCCESS"] },
    updatedAt: { $gte: lookback },
  })
    .sort({ updatedAt: 1 })
    .limit(SYNC_BATCH_SIZE)
    .lean();

  if (!rows.length) return;

  const userCache = new Map<string, any>();
  let synced = 0;

  for (const row of rows) {
    const userId = String((row as any)?.userId || "").trim();
    const orderId = String((row as any)?.orderId || "").trim();
    if (!userId || !orderId) continue;

    let userDoc = userCache.get(userId);
    if (!userDoc) {
      userDoc = await User.findById(userId).select("+client_key").lean();
      userCache.set(userId, userDoc || null);
    }
    if (!userDoc?.client_key) continue;

    const clientCode = decrypt(userDoc.client_key, `signal_status_sync_${userId}`);
    if (!clientCode) continue;

    let brokerOrder: any = null;
    try {
      brokerOrder = await fetchBrokerOrder(userId, clientCode, orderId);
    } catch (err: any) {
      log.warn("[SignalStatusSync] Broker fetch failed", {
        userId,
        orderId,
        message: err?.message,
      });
      continue;
    }
    if (!brokerOrder || typeof brokerOrder !== "object") continue;

    const brokerStatus = normalizeBrokerOrderStatus(brokerOrder);
    if (!brokerStatus) continue;

    let nextStatus = String((row as any)?.status || "PENDING").toUpperCase();
    const currentError = String((row as any)?.errorMessage || "").trim();
    const currentReject = String((row as any)?.brokerRejectReason || "").trim();
    let nextError = currentError;
    let nextReject = currentReject;

    if (isRejectedStatus(brokerStatus)) {
      nextStatus = "FAILED";
      nextReject = extractRejectReason(brokerOrder);
      nextError = nextReject;
    } else if (isAcceptedStatus(brokerStatus)) {
      nextStatus = "SUCCESS";
      nextReject = "";
      if (nextError === "Order rejected by broker") {
        nextError = "";
      }
    } else if (isPendingStatus(brokerStatus)) {
      nextStatus = "PENDING";
    }

    const hasChanged =
      nextStatus !== String((row as any)?.status || "").toUpperCase() ||
      brokerStatus !== String((row as any)?.brokerOrderStatus || "") ||
      nextReject !== currentReject ||
      nextError !== currentError;

    const updateOps: any = {
      $set: {
        status: nextStatus,
        brokerOrderStatus: brokerStatus,
        brokerResponse: brokerOrder,
        errorMessage: nextError || undefined,
        brokerRejectReason: nextReject || undefined,
        lastSyncedAt: new Date(),
      },
    };

    if (!nextReject) {
      updateOps.$unset = { brokerRejectReason: 1 };
    }

    await SignalExecutionResult.updateOne({ _id: (row as any)._id }, updateOps);
    synced += 1;

    if (hasChanged) {
      broadcastToUser(userId, {
        type: "TRADE_EXECUTION_UPDATE",
        data: {
          signalId: String((row as any)?.signalId || ""),
          clientOrderId: String((row as any)?.clientOrderId || ""),
          orderId,
          status: nextStatus,
          brokerOrderStatus: brokerStatus,
          errorMessage: nextError || null,
          brokerRejectReason: nextReject || null,
          syncedAt: new Date().toISOString(),
        },
      });
    }
  }

  if (synced > 0) {
    log.debug("[SignalStatusSync] Status sync cycle completed", { synced, scanned: rows.length });
  }
};

