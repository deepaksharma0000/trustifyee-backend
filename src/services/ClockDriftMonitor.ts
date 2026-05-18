// src/services/ClockDriftMonitor.ts
import log from "../utils/logger";

export type ExecutionSafetyMode = 
  | "NORMAL_MODE"
  | "DEGRADED_MODE"
  | "ENTRY_BLOCK_MODE"
  | "READ_ONLY_MODE"
  | "PANIC_LIQUIDATION_MODE";

export interface TemporalMetrics {
  driftConfidence: number;
  monotonicDriftDeltaMs: number;
  lastSyncTimestamp: number;
  driftOutagesCount: number;
  currentSafetyMode: ExecutionSafetyMode;
}

export class ClockDriftMonitor {
  private static instance: ClockDriftMonitor;

  // High-Resolution Monotonic baseline variables
  private readonly startHrTime: bigint;
  private readonly startWallTimeMs: number;

  // Configuration limits
  private readonly DEGRADED_DRIFT_THRESHOLD_MS = 200;      // Warning mode
  private readonly BLOCK_ENTRY_DRIFT_THRESHOLD_MS = 500;     // Block entry trades
  private readonly PANIC_DRIFT_THRESHOLD_MS = 1000;         // Liquidation only mode

  private currentSafetyMode: ExecutionSafetyMode = "NORMAL_MODE";
  private driftConfidence = 100; // 0 to 100%
  private driftOutagesCount = 0;
  private lastDriftDeltaMs = 0;

  private constructor() {
    this.startHrTime = process.hrtime.bigint();
    this.startWallTimeMs = Date.now();
    
    // Periodically run self-drift check against local monotonic time
    setInterval(() => {
      this.evaluateInternalConsistency();
    }, 5000);
  }

  public static getInstance(): ClockDriftMonitor {
    if (!ClockDriftMonitor.instance) {
      ClockDriftMonitor.instance = new ClockDriftMonitor();
    }
    return ClockDriftMonitor.instance;
  }

  /**
   * Returns current high-precision monotonic time aligned with Wall-Clock baseline.
   * Eliminates system Date.now() backward jumps.
   */
  public getMonotonicNow(): number {
    const elapsedNs = process.hrtime.bigint() - this.startHrTime;
    const elapsedMs = Number(elapsedNs / 1000000n);
    return this.startWallTimeMs + elapsedMs;
  }

  public getMetrics(): TemporalMetrics {
    return {
      driftConfidence: this.driftConfidence,
      monotonicDriftDeltaMs: this.lastDriftDeltaMs,
      lastSyncTimestamp: Date.now(),
      driftOutagesCount: this.driftOutagesCount,
      currentSafetyMode: this.currentSafetyMode,
    };
  }

  public getSafetyMode(): ExecutionSafetyMode {
    return this.currentSafetyMode;
  }

  /**
   * Multi-Source drift evaluation logic.
   * Compares incoming tick broker timestamp, local system wall-clock, and high-precision monotonic timeline.
   */
  public validateTickTimestamp(brokerTimestampMs: number): boolean {
    const monotonicNow = this.getMonotonicNow();
    const systemNow = Date.now();
    
    // Calculate deviation between broker and high-precision monotonic timeline
    const driftDelta = Math.abs(monotonicNow - brokerTimestampMs);
    this.lastDriftDeltaMs = driftDelta;

    // Detect high wall-clock deviation (NTP jump detection)
    const wallClockDeviation = Math.abs(systemNow - monotonicNow);
    if (wallClockDeviation > 1000) {
      log.error(`[ClockDrift] CRITICAL NTP CLOCK JUMP DETECTED! Local system clock shifted by ${wallClockDeviation}ms from Monotonic baseline.`);
      this.driftConfidence = Math.max(0, this.driftConfidence - 30);
    }

    // Evaluate drift thresholds and escalate safety modes
    this.evaluateThresholds(driftDelta);

    // Reject processing if we are in READ_ONLY or PANIC_LIQUIDATION
    if (this.currentSafetyMode === "READ_ONLY_MODE") {
      log.warn(`[ClockDrift] Tick rejected. Current safety mode is READ_ONLY.`);
      return false;
    }

    return true;
  }

  private evaluateThresholds(driftDelta: number) {
    if (driftDelta >= this.PANIC_DRIFT_THRESHOLD_MS) {
      if (this.currentSafetyMode !== "PANIC_LIQUIDATION_MODE") {
        this.currentSafetyMode = "PANIC_LIQUIDATION_MODE";
        this.driftOutagesCount += 1;
        this.driftConfidence = 0;
        log.error(`[ClockDrift] PANIC! Clock drift reached ${driftDelta}ms. Escalating to PANIC_LIQUIDATION_MODE.`);
      }
    } else if (driftDelta >= this.BLOCK_ENTRY_DRIFT_THRESHOLD_MS) {
      if (this.currentSafetyMode !== "ENTRY_BLOCK_MODE") {
        this.currentSafetyMode = "ENTRY_BLOCK_MODE";
        this.driftConfidence = 30;
        log.error(`[ClockDrift] WARNING! Clock drift reached ${driftDelta}ms. Escalating to ENTRY_BLOCK_MODE.`);
      }
    } else if (driftDelta >= this.DEGRADED_DRIFT_THRESHOLD_MS) {
      if (this.currentSafetyMode !== "DEGRADED_MODE") {
        this.currentSafetyMode = "DEGRADED_MODE";
        this.driftConfidence = 70;
        log.warn(`[ClockDrift] Clock drift reached ${driftDelta}ms. Shifting to DEGRADED_MODE.`);
      }
    } else {
      if (this.currentSafetyMode !== "NORMAL_MODE") {
        this.currentSafetyMode = "NORMAL_MODE";
        this.driftConfidence = 100;
        log.info(`[ClockDrift] Time synchronization restored. Returning to NORMAL_MODE.`);
      }
    }
  }

  private evaluateInternalConsistency() {
    const wallNow = Date.now();
    const monotonicNow = this.getMonotonicNow();
    const diff = Math.abs(wallNow - monotonicNow);

    if (diff > 50) {
      log.warn(`[ClockDrift] Internal timeline asymmetry detected: System Wall Clock is drifting from Monotonic Clock by ${diff}ms.`);
    }
  }

  /**
   * Enforces rules for allowed operations per Mode.
   */
  public isEntryAllowed(): boolean {
    const mode = this.currentSafetyMode;
    return mode === "NORMAL_MODE" || mode === "DEGRADED_MODE";
  }

  public isExitAllowed(): boolean {
    const mode = this.currentSafetyMode;
    return mode !== "READ_ONLY_MODE";
  }
}

export const clockDriftMonitor = ClockDriftMonitor.getInstance();
