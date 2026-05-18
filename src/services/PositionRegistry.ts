// src/services/PositionRegistry.ts
import log from "../utils/logger";

export type PositionState = "OPEN" | "RISK_TRIGGERED" | "EXITING" | "PARTIALLY_EXITED" | "CLOSED" | "RECONCILING";

export interface ActivePosition {
  positionId: string;
  userId: string;
  runId: string;
  tradingsymbol: string;
  exchange: string;
  symboltoken: string;
  side: "BUY" | "SELL";
  entryPricePaisa: number; // Stored in Paisa (Integer) to avoid floating-point drift
  quantity: number;        // Total quantity requested
  executedQty: number;     // Quantity executed so far
  remainingQty: number;    // Quantity left to execute
  stopLossPaisa: number;   // Calculated stop loss price in Paisa
  targetPaisa: number;     // Calculated target price in Paisa
  status: PositionState;
  lastHeartbeat: number;
}

export class PositionRegistry {
  private static instance: PositionRegistry;
  
  // Isolated fast maps for indexing (positionId -> ActivePosition)
  private registry = new Map<string, ActivePosition>();
  
  // Exchange token lookup mapping (exchange:token -> positionIds[])
  private indexByToken = new Map<string, string[]>();

  private constructor() {}

  public static getInstance(): PositionRegistry {
    if (!PositionRegistry.instance) {
      PositionRegistry.instance = new PositionRegistry();
    }
    return PositionRegistry.instance;
  }

  register(pos: ActivePosition) {
    if (this.registry.has(pos.positionId)) {
      log.warn(`[PositionRegistry] Position ${pos.positionId} already registered. Overwriting reference.`);
      this.deregister(pos.positionId);
    }

    pos.lastHeartbeat = Date.now();
    
    // Enforce integer calculations
    pos.entryPricePaisa = Math.round(pos.entryPricePaisa);
    pos.stopLossPaisa = Math.round(pos.stopLossPaisa);
    pos.targetPaisa = Math.round(pos.targetPaisa);
    pos.remainingQty = pos.quantity - pos.executedQty;

    this.registry.set(pos.positionId, pos);

    const tokenKey = `${pos.exchange}:${pos.symboltoken}`.toUpperCase().trim();
    if (!this.indexByToken.has(tokenKey)) {
      this.indexByToken.set(tokenKey, []);
    }
    this.indexByToken.get(tokenKey)!.push(pos.positionId);
    
    log.info(`[PositionRegistry] Registered active position: ${pos.tradingsymbol} for user ${pos.userId}. Quantity: ${pos.quantity}`);
  }

  deregister(positionId: string) {
    const pos = this.registry.get(positionId);
    if (!pos) return;

    this.registry.delete(positionId);

    const tokenKey = `${pos.exchange}:${pos.symboltoken}`.toUpperCase().trim();
    const indices = this.indexByToken.get(tokenKey);
    if (indices) {
      const filtered = indices.filter(id => id !== positionId);
      if (filtered.length === 0) {
        this.indexByToken.delete(tokenKey);
      } else {
        this.indexByToken.set(tokenKey, filtered);
      }
    }
    log.info(`[PositionRegistry] Deregistered position: ${positionId}`);
  }

  updatePartialFill(positionId: string, filledQty: number, avgPricePaisa: number) {
    const pos = this.registry.get(positionId);
    if (!pos) return;

    pos.executedQty += filledQty;
    pos.remainingQty = Math.max(0, pos.quantity - pos.executedQty);
    pos.entryPricePaisa = Math.round(avgPricePaisa);
    pos.lastHeartbeat = Date.now();

    if (pos.remainingQty === 0) {
      pos.status = "CLOSED";
      this.deregister(positionId);
    } else {
      pos.status = "PARTIALLY_EXITED";
    }

    log.info(`[PositionRegistry] Partial Fill Update. Position: ${positionId}, ExecutedQty: ${pos.executedQty}, RemainingQty: ${pos.remainingQty}, AvgPricePaisa: ${avgPricePaisa}`);
  }

  updateState(positionId: string, newState: PositionState) {
    const pos = this.registry.get(positionId);
    if (!pos) return;

    pos.status = newState;
    pos.lastHeartbeat = Date.now();

    if (newState === "CLOSED") {
      this.deregister(positionId);
    }
  }

  getPosition(positionId: string): ActivePosition | undefined {
    return this.registry.get(positionId);
  }

  getPositionsByToken(exchange: string, token: string): ActivePosition[] {
    const tokenKey = `${exchange}:${token}`.toUpperCase().trim();
    const ids = this.indexByToken.get(tokenKey) || [];
    return ids.map(id => this.registry.get(id)!).filter(Boolean);
  }

  // Periodic sweeper to clean up stale strategy/run allocations
  sweepOrphans(ttlMs = 60000) {
    const now = Date.now();
    for (const [id, pos] of this.registry.entries()) {
      if (now - pos.lastHeartbeat > ttlMs) {
        log.error(`[PositionRegistry] ORPHAN DETECTED: Position ${id} (${pos.tradingsymbol}) missed heartbeats. Sweeping.`);
        this.updateState(id, "CLOSED");
      }
    }
  }

  clear() {
    this.registry.clear();
    this.indexByToken.clear();
  }
}

export const positionRegistry = PositionRegistry.getInstance();
