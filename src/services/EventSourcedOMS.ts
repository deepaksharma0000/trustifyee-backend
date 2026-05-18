// src/services/EventSourcedOMS.ts
import crypto from "crypto";
import OMSEventModel from "../models/OMSEvent";
import log from "../utils/logger";

export type OMSState =
  | "CREATED"
  | "INTENT_LOGGED"
  | "SUBMITTED"
  | "ACKNOWLEDGED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "REJECTED"
  | "CANCELLED"
  | "RECONCILING"
  | "FAILED";

export interface OrderStateSnapshot {
  orderId: string;
  clientOrderId: string;
  positionId: string;
  userId: string;
  tradingsymbol: string;
  side: "BUY" | "SELL";
  status: OMSState;
  quantity: number;
  executedQty: number;
  remainingQty: number;
  avgPricePaisa: number;
  reconciling: boolean;
  lastSequence: number;
  updatedAt: number;
}

export interface OMSMetrics {
  totalOrdersPlaced: number;
  activeOrdersCount: number;
  reconciliationEscalations: number;
  duplicateCallbackSuppressions: number;
  replayCount: number;
  brokerHealthScore: number; // 0 to 100
  safeModeActive: boolean;
}

export class EventSourcedOMS {
  private static instance: EventSourcedOMS;
  private startupCorrelationId: string = "unknown";

  public setStartupCorrelationId(id: string) {
    this.startupCorrelationId = id;
    log.info(`[OMS] Configured Startup Correlation ID: ${id}`);
  }
  
  // In-memory snapshots registry for O(1) lookups
  private snapshots = new Map<string, OrderStateSnapshot>(); // clientOrderId -> OrderStateSnapshot
  
  // Broker Callback Deduplication Registry (dedupKey -> true)
  private callbackDedupRegistry = new Set<string>();

  // Monotonic sequence mapping (clientOrderId -> sequenceNumber)
  private sequenceCounter = new Map<string, number>();

  // Diagnostic Telemetry Metrics
  private metrics: OMSMetrics = {
    totalOrdersPlaced: 0,
    activeOrdersCount: 0,
    reconciliationEscalations: 0,
    duplicateCallbackSuppressions: 0,
    replayCount: 0,
    brokerHealthScore: 100,
    safeModeActive: false,
  };

  // Broker Health Evaluator counters
  private recentSubmits = 0;
  private recentFailures = 0;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  private constructor() {
    // Background broker health tracker (evaluated every 10s)
    this.healthCheckInterval = setInterval(() => {
      this.evaluateBrokerHealth();
    }, 10000);
  }

  public static getInstance(): EventSourcedOMS {
    if (!EventSourcedOMS.instance) {
      EventSourcedOMS.instance = new EventSourcedOMS();
    }
    return EventSourcedOMS.instance;
  }

  getMetrics(): OMSMetrics {
    this.metrics.activeOrdersCount = Array.from(this.snapshots.values()).filter(
      (o) => o.status !== "FILLED" && o.status !== "REJECTED" && o.status !== "CANCELLED" && o.status !== "FAILED"
    ).length;
    return { ...this.metrics };
  }

  // 🛡️ Deterministic Replay-Safe clientOrderId generator
  public generateClientOrderId(correlationId: string, positionId: string, side: string, strategyRunId: string): string {
    const rawString = `${correlationId}:${positionId}:${side}:${strategyRunId}`;
    return crypto
      .createHash("sha256")
      .update(rawString)
      .digest("hex")
      .slice(0, 32); // Limit to 32 characters for broker API compatibility
  }

  // 🚀 TRANSACTIONAL WRITE-AHEAD APPEND-ONLY EVENT SYSTEM
  public async appendEvent(
    clientOrderId: string,
    orderId: string,
    eventType: OMSState,
    payload: Record<string, any>
  ): Promise<OrderStateSnapshot> {
    // 🛡️ Block new placements in SAFE_BOOT_MODE
    if ((eventType === "CREATED" || eventType === "INTENT_LOGGED") && !payload.isReconciliation) {
      try {
        const { StartupDiagnostics } = require("../utils/startupDiagnostics");
        if (StartupDiagnostics.isSafeBootMode()) {
          log.error(`[OMS] Blocked order placement for clientOrderId: ${clientOrderId} due to active SAFE_BOOT_MODE`);
          throw new Error("OMS_ENTRY_BLOCKED: Placements are blocked because the system is running in SAFE_BOOT_MODE.");
        }
      } catch (diagErr: any) {
        if (diagErr.message.includes("OMS_ENTRY_BLOCKED")) {
          throw diagErr;
        }
      }
    }
    
    // Acquire next monotonic sequence number per order instance
    const currentSeq = (this.sequenceCounter.get(clientOrderId) || 0) + 1;
    this.sequenceCounter.set(clientOrderId, currentSeq);

    // Persist event atomically to Mongo (immutable write-ahead event sourced transaction)
    await OMSEventModel.create({
      clientOrderId,
      orderId,
      sequence: currentSeq,
      eventType,
      payload,
    });

    // Reconstruct and update local cache state snapshot
    let snapshot = this.snapshots.get(clientOrderId);
    if (!snapshot) {
      snapshot = {
        orderId,
        clientOrderId,
        positionId: payload.positionId || "",
        userId: payload.userId || "",
        tradingsymbol: payload.tradingsymbol || "",
        side: payload.side || "BUY",
        status: "CREATED",
        quantity: payload.quantity || 0,
        executedQty: 0,
        remainingQty: payload.quantity || 0,
        avgPricePaisa: 0,
        reconciling: false,
        lastSequence: 0,
        updatedAt: Date.now(),
      };
    }

    this.applyEventToSnapshot(snapshot, eventType, currentSeq, payload);
    this.snapshots.set(clientOrderId, snapshot);

    if (eventType === "CREATED") {
      this.metrics.totalOrdersPlaced += 1;
      this.recentSubmits += 1;
    }

    if (eventType === "FAILED" || eventType === "REJECTED") {
      this.recentFailures += 1;
    }

    return snapshot;
  }

  // 🛡️ REPLAY STATE MACHINE TRANSITIONS deterministically
  private applyEventToSnapshot(
    snapshot: OrderStateSnapshot,
    eventType: OMSState,
    sequence: number,
    payload: Record<string, any>
  ) {
    snapshot.status = eventType;
    snapshot.lastSequence = sequence;
    snapshot.updatedAt = Date.now();

    switch (eventType) {
      case "CREATED":
        snapshot.quantity = payload.quantity;
        snapshot.remainingQty = payload.quantity;
        snapshot.executedQty = 0;
        break;

      case "ACKNOWLEDGED":
        if (payload.brokerOrderId) {
          snapshot.orderId = payload.brokerOrderId;
        }
        break;

      case "PARTIALLY_FILLED":
        const fillQty = payload.fillQty || 0;
        const fillPricePaisa = Math.round((payload.fillPrice || 0) * 100);
        
        // Calculate incremental weighted average fill price evolution safely
        const totalOldCost = snapshot.executedQty * snapshot.avgPricePaisa;
        const totalNewCost = fillQty * fillPricePaisa;
        
        snapshot.executedQty += fillQty;
        snapshot.remainingQty = Math.max(0, snapshot.quantity - snapshot.executedQty);
        
        if (snapshot.executedQty > 0) {
          snapshot.avgPricePaisa = Math.round((totalOldCost + totalNewCost) / snapshot.executedQty);
        }
        
        if (snapshot.remainingQty === 0) {
          snapshot.status = "FILLED";
        }
        break;

      case "FILLED":
        snapshot.executedQty = snapshot.quantity;
        snapshot.remainingQty = 0;
        if (payload.price) {
          snapshot.avgPricePaisa = Math.round(payload.price * 100);
        }
        break;

      case "RECONCILING":
        snapshot.reconciling = true;
        break;

      case "FAILED":
      case "REJECTED":
      case "CANCELLED":
        snapshot.remainingQty = 0;
        snapshot.reconciling = false;
        break;
    }
  }

  // 🛡️ RECOVERY ENGINE: Warmup and restore full state from append-only DB ledger
  public async recoverStateFromDb() {
    log.info("[EventSourcedOMS] Starting full state recovery from event logs...");
    const startedAt = Date.now();

    this.snapshots.clear();
    this.sequenceCounter.clear();

    // Query all event logs ordered chronologically by sequence
    const allEvents = await OMSEventModel.find({}).sort({ clientOrderId: 1, sequence: 1 }).lean();

    allEvents.forEach((ev) => {
      let snapshot = this.snapshots.get(ev.clientOrderId);
      if (!snapshot) {
        snapshot = {
          orderId: ev.orderId,
          clientOrderId: ev.clientOrderId,
          positionId: ev.payload.positionId || "",
          userId: ev.payload.userId || "",
          tradingsymbol: ev.payload.tradingsymbol || "",
          side: ev.payload.side || "BUY",
          status: "CREATED",
          quantity: ev.payload.quantity || 0,
          executedQty: 0,
          remainingQty: ev.payload.quantity || 0,
          avgPricePaisa: 0,
          reconciling: false,
          lastSequence: 0,
          updatedAt: Date.now(),
        };
      }

      this.applyEventToSnapshot(snapshot, ev.eventType as OMSState, ev.sequence, ev.payload);
      this.snapshots.set(ev.clientOrderId, snapshot);
      this.sequenceCounter.set(ev.clientOrderId, ev.sequence);
    });

    this.metrics.replayCount += 1;
    log.info(`[EventSourcedOMS] Recovery completed in ${Date.now() - startedAt}ms. Rebuilt ${this.snapshots.size} order snapshots.`);
  }

  // 🛡️ BROKER CALLBACK DEDUPLICATION GATEWAY
  public isDuplicateCallback(brokerCallbackId: string): boolean {
    if (this.callbackDedupRegistry.has(brokerCallbackId)) {
      this.metrics.duplicateCallbackSuppressions += 1;
      return true;
    }
    this.callbackDedupRegistry.add(brokerCallbackId);
    
    // Maintain a sliding window size of 5000 entries to prevent memory leaks
    if (this.callbackDedupRegistry.size > 5000) {
      const firstElement = this.callbackDedupRegistry.values().next().value;
      if (firstElement) this.callbackDedupRegistry.delete(firstElement);
    }
    return false;
  }

  // 🛡️ REACTIVE RECONCILIATION ESCALATOR
  public async checkForPendingTimeouts(timeoutMs = 12000) {
    const now = Date.now();
    for (const [clientOrderId, snapshot] of this.snapshots.entries()) {
      if (
        (snapshot.status === "SUBMITTED" || snapshot.status === "INTENT_LOGGED") &&
        now - snapshot.updatedAt > timeoutMs &&
        !snapshot.reconciling
      ) {
        this.metrics.reconciliationEscalations += 1;
        log.warn(`[EventSourcedOMS] RECONCILIATION TIMEOUT BREACHED! clientOrderId: ${clientOrderId}. Escalating state to RECONCILING.`);
        
        await this.appendEvent(clientOrderId, snapshot.orderId, "RECONCILING", {
          reason: "PENDING_EXECUTION_TIMEOUT",
          elapsedMs: now - snapshot.updatedAt,
        });

        // Trigger background reconciliation order fetch jobs safely
        this.dispatchBackgroundReconciliation(snapshot);
      }
    }
  }

  private dispatchBackgroundReconciliation(snapshot: OrderStateSnapshot) {
    // Non-blocking trigger to verify broker order status
    setTimeout(async () => {
      try {
        log.info(`[EventSourcedOMS] Running background order status check for: ${snapshot.orderId}`);
        // OMS order status checking and state convergence logic will trigger here in Week 4
      } catch (err: any) {
        log.error(`[EventSourcedOMS] Background reconciliation failed:`, err.message);
      }
    }, 1000);
  }

  // 🛡️ BROKER HEALTH ESCALATION & AUTO-SAFE PROTECTION
  private evaluateBrokerHealth() {
    if (this.recentSubmits === 0) {
      this.metrics.brokerHealthScore = 100;
      return;
    }

    const failureRate = this.recentFailures / this.recentSubmits;
    const score = Math.max(0, 100 - Math.round(failureRate * 100));
    this.metrics.brokerHealthScore = score;

    // Reset periodic counters
    this.recentSubmits = 0;
    this.recentFailures = 0;

    // Trigger SAFE_MODE if health score collapses below 75%
    if (score < 75 && !this.metrics.safeModeActive) {
      this.metrics.safeModeActive = true;
      log.error(`[EventSourcedOMS] BROKER HEALTH CRITICAL! Score: ${score}%. Triggering emergency SAFE_MODE execution restrictions.`);
    } else if (score >= 90 && this.metrics.safeModeActive) {
      this.metrics.safeModeActive = false;
      log.warn(`[EventSourcedOMS] Broker health stabilized. Score: ${score}%. Revoking SAFE_MODE.`);
    }
  }
}

export const eventSourcedOMS = EventSourcedOMS.getInstance();
