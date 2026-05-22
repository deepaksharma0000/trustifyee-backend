// src/services/ReconciliationService.ts
import { positionRegistry, ActivePosition } from "./PositionRegistry";
import { eventSourcedOMS } from "./EventSourcedOMS";
import { getOrCreateAngelAdapter } from "./AngelAdapterRegistry";
import AngelTokensModel from "../models/AngelTokens";
import { decrypt } from "../utils/encryption";
import log from "../utils/logger";

export type ReconciliationState = "RECON_PENDING" | "RECON_ESCALATED" | "RECON_RECOVERED" | "RECON_FAILED" | "RECON_CONFIRMED";

export interface MismatchRecord {
  scripKey: string;
  type: "GHOST_POSITION" | "STALE_POSITION" | "QUANTITY_MISMATCH";
  localQty: number;
  brokerQty: number;
  confidenceScore: number;
  firstDetected: number;
}

export interface CorrelationTrace {
  signalId: string;
  positionId: string;
  clientOrderId: string;
  brokerOrderId: string;
  omsState: string;
  reconciliationState: ReconciliationState;
  timestamp: number;
}

export interface ReconciliationMetrics {
  sweepsCompleted: number;
  ghostPositionsIdentified: number;
  repairsExecuted: number;
  averageAuditLatencyMs: number;
  brokerInconsistencyRate: number;
}

export class ReconciliationService {
  private static instance: ReconciliationService;
  private startupCorrelationId: string = "unknown";

  public setStartupCorrelationId(id: string) {
    this.startupCorrelationId = id;
    log.info(`[ReconciliationService] Configured Startup Correlation ID: ${id}`);
  }
  
  // Track mismatches across sweeps to tolerate transient broker delays (eventual consistency)
  private pendingMismatches = new Map<string, MismatchRecord>(); // scripKey -> MismatchRecord
  
  // Correlation ledger trace index
  private correlationLedger = new Map<string, CorrelationTrace>(); // positionId -> CorrelationTrace

  // Telemetry metrics
  private metrics: ReconciliationMetrics = {
    sweepsCompleted: 0,
    ghostPositionsIdentified: 0,
    repairsExecuted: 0,
    averageAuditLatencyMs: 0,
    brokerInconsistencyRate: 0,
  };

  private constructor() {}

  public static getInstance(): ReconciliationService {
    if (!ReconciliationService.instance) {
      ReconciliationService.instance = new ReconciliationService();
    }
    return ReconciliationService.instance;
  }

  getMetrics(): ReconciliationMetrics {
    return { ...this.metrics };
  }

  /**
   * Tracks full transaction traceability from entry signal to final trade execution.
   */
  logTrace(trace: CorrelationTrace) {
    this.correlationLedger.set(trace.positionId, trace);
    log.info(`[ReconciliationTrace] Indexed correlation flow for Position: ${trace.positionId}. clientOrderId: ${trace.clientOrderId}, brokerId: ${trace.brokerOrderId}`);
  }

  getTrace(positionId: string): CorrelationTrace | undefined {
    return this.correlationLedger.get(positionId);
  }

  /**
   * Bidirectional event-sourced position auditor.
   * Compares memory registry against real-time broker orderbooks.
   */
  async runAudit(userId: string, clientCode: string) {
    const startTime = Date.now();
    this.metrics.sweepsCompleted += 1;

    try {
      const tokens = await AngelTokensModel.findOne({ userId, clientcode: clientCode }).lean();
      if (!tokens || !tokens.jwtToken) {
        log.warn(`[Reconciliation] Session credentials missing for ${clientCode}. Skipping audit.`);
        return;
      }

      const decJwtToken = decrypt(tokens.jwtToken);
      const decApiKey = decrypt(tokens.apiKey || "");
      
      const adapter = getOrCreateAngelAdapter(decApiKey);
      
      // Query current active position data directly from AngelOne
      const brokerResponse = await adapter.getPositions(decJwtToken);

      // [FIX] Ensure we have an array before attempting iteration
      if (!brokerResponse || !brokerResponse.data || !Array.isArray(brokerResponse.data)) {
        log.error(`[Reconciliation] Invalid broker response for ${clientCode}:`, brokerResponse);
        return;
      }
      const brokerPositions = brokerResponse.data;

      // 1. Map broker positions by token for O(1) comparison
      const brokerMap = new Map<string, any>();
      brokerPositions.forEach((pos: any) => {
        const key = `${pos.exchange}:${pos.symboltoken}`.toUpperCase().trim();
        brokerMap.set(key, pos);
      });

      // 2. Map local positions by token for O(1) comparison
      const localPositions = positionRegistry.getPositionsByToken("", ""); // Get all active positions
      const localMap = new Map<string, ActivePosition>();
      
      // Fetch positions registered locally
      // For this implementation, we query positions by accessing registry records
      const allRegistered = (positionRegistry as any).registry as Map<string, ActivePosition>;
      allRegistered.forEach((pos) => {
        const key = `${pos.exchange}:${pos.symboltoken}`.toUpperCase().trim();
        localMap.set(key, pos);
      });

      const processedKeys = new Set<string>();

      // ==========================================
      // AUDIT 1: LOCAL POSITIONS -> BROKER POSITIONS (Detect Stale Local Records)
      // ==========================================
      for (const [key, localPos] of localMap.entries()) {
        processedKeys.add(key);
        const brokerPos = brokerMap.get(key);

        const localQty = localPos.remainingQty;
        const brokerQty = brokerPos ? Math.abs(Number(brokerPos.netqty)) : 0;

        if (localQty > 0 && (!brokerPos || brokerQty === 0)) {
          // Stale local state: registered locally but closed on broker
          this.registerMismatch(key, "STALE_POSITION", localQty, 0);
        } else if (brokerPos && localQty !== brokerQty) {
          // Quantity mismatch between local OMS and exchange
          this.registerMismatch(key, "QUANTITY_MISMATCH", localQty, brokerQty);
        } else {
          // Matched, clear any transient mismatches registered before
          this.pendingMismatches.delete(key);
        }
      }

      // ==========================================
      // AUDIT 2: BROKER POSITIONS -> LOCAL POSITIONS (Detect Ghost / Orphan Positions)
      // ==========================================
      for (const [key, brokerPos] of brokerMap.entries()) {
        if (processedKeys.has(key)) continue;

        const brokerQty = Math.abs(Number(brokerPos.netqty));
        if (brokerQty > 0) {
          // Ghost Position: exists on broker but entirely unrecorded in memory!
          this.registerMismatch(key, "GHOST_POSITION", 0, brokerQty);
        }
      }

      // 3. Process and escalate mismatches that cross the confidence threshold
      await this.processEscalations(userId, clientCode);

    } catch (err: any) {
      log.error(`[Reconciliation] Audit sweep failed for ${clientCode}:`, err.message);
    } finally {
      const duration = Date.now() - startTime;
      this.metrics.averageAuditLatencyMs = Math.round(
        (this.metrics.averageAuditLatencyMs * 9 + duration) / 10
      );
    }
  }

  private registerMismatch(key: string, type: MismatchRecord["type"], localQty: number, brokerQty: number) {
    const existing = this.pendingMismatches.get(key);
    if (existing) {
      // Increment confidence score for mismatch persistence
      existing.confidenceScore = Math.min(100, existing.confidenceScore + 20);
      log.warn(`[Reconciliation] Mismatch persisting for ${key}. Type: ${type}, Local Qty: ${localQty}, Broker Qty: ${brokerQty}. Confidence: ${existing.confidenceScore}%`);
    } else {
      this.pendingMismatches.set(key, {
        scripKey: key,
        type,
        localQty,
        brokerQty,
        confidenceScore: 20,
        firstDetected: Date.now(),
      });
      log.warn(`[Reconciliation] Mismatch detected for ${key}. Type: ${type}, Local Qty: ${localQty}, Broker Qty: ${brokerQty}.`);
    }
  }

  /**
   * Evaluates registered mismatches and executes event-sourced repairs
   * if the confidence score reaches 100% (eventual consistency buffer).
   */
  private async processEscalations(userId: string, clientCode: string) {
    const now = Date.now();
    for (const [key, record] of this.pendingMismatches.entries()) {
      
      // Grace window of 5 seconds to ignore transient execution lags
      if (now - record.firstDetected < 5000) continue;

      if (record.confidenceScore >= 100) {
        log.error(`[Reconciliation] AUDIT FAILURE ESCALATED! Triggering automated event-sourced repairs for ${key}`);
        
        const [exchange, token] = record.scripKey.split(":");

        if (record.type === "GHOST_POSITION") {
          this.metrics.ghostPositionsIdentified += 1;
          
          // Append immutable recovery audit event
          await eventSourcedOMS.appendEvent(
            `RECON_${token}_${now}`,
            "RECON_GHOST",
            "CREATED",
            {
              userId,
              tradingsymbol: `GHOST_${token}`,
              exchange,
              side: "BUY",
              quantity: record.brokerQty,
              reason: "GHOST_POSITION_DISCOVERED",
            }
          );

          log.warn(`[Reconciliation] GHOST_POSITION repaired. Triggered event log recovery for scrip token ${token}`);
          this.metrics.repairsExecuted += 1;
        }

        if (record.type === "STALE_POSITION") {
          // Local registry thinks position is open but it's closed on broker -> Flatten local state
          const allRegistered = (positionRegistry as any).registry as Map<string, ActivePosition>;
          for (const [posId, pos] of allRegistered.entries()) {
            if (pos.exchange === exchange && pos.symboltoken === token) {
              log.warn(`[Reconciliation] STALE_POSITION repair: flattening local stale state for ${pos.tradingsymbol}`);
              positionRegistry.updateState(posId, "CLOSED");
              
              await eventSourcedOMS.appendEvent(
                posId,
                pos.positionId || "UNKNOWN",
                "CANCELLED",
                {
                  reason: "STALE_RECONCILIATION_FLATTENING",
                }
              );
            }
          }
          this.metrics.repairsExecuted += 1;
        }

        // Repair complete, remove from track map
        this.pendingMismatches.delete(key);
      }
    }
  }
}

export const reconciliationService = ReconciliationService.getInstance();
