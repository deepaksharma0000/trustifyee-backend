// src/services/ObservabilityStack.ts
import log from "../utils/logger";

export interface AlertRecord {
  id: string;
  type: "LATP_SPIKE" | "RECON_MISMATCH" | "DUPLICATE_FILL" | "STUCK_ORDER" | "SHADOW_DIVERGENCE" | "SANDBOX_CRASH";
  message: string;
  timestamp: number;
  severity: "WARNING" | "CRITICAL";
}

export interface MetricSnapshot {
  tickThroughput: number;
  avgOmsLatencyMs: number;
  avgReconLatencyMs: number;
  reconMismatchesCount: number;
  activeAlertsCount: number;
}

export class ObservabilityStack {
  private static instance: ObservabilityStack;

  private alerts: AlertRecord[] = [];
  private totalTicksProcessed = 0;
  private omsLatencies: number[] = [];
  private reconLatencies: number[] = [];
  private reconMismatches = 0;

  private constructor() {}

  public static getInstance(): ObservabilityStack {
    if (!ObservabilityStack.instance) {
      ObservabilityStack.instance = new ObservabilityStack();
    }
    return ObservabilityStack.instance;
  }

  public registerTickProcessed() {
    this.totalTicksProcessed += 1;
  }

  public recordOmsLatency(ms: number) {
    this.omsLatencies.push(ms);
    if (this.omsLatencies.length > 100) this.omsLatencies.shift(); // sliding window of 100
  }

  public recordReconLatency(ms: number) {
    this.reconLatencies.push(ms);
    if (this.reconLatencies.length > 100) this.reconLatencies.shift(); // sliding window of 100
  }

  public registerReconMismatch() {
    this.reconMismatches += 1;
    this.triggerAlert("RECON_MISMATCH", "RECONCILIATION FAILURE: Position discrepancy identified during bidirectional audit.", "WARNING");
  }

  /**
   * High-fidelity alert trigger dispatcher.
   */
  public triggerAlert(
    type: AlertRecord["type"],
    message: string,
    severity: AlertRecord["severity"]
  ) {
    const id = `ALERT_${type}_${Date.now()}`;
    const alert: AlertRecord = { id, type, message, timestamp: Date.now(), severity };
    
    this.alerts.push(alert);
    log.error(`[OBSERVABILITY_ALERT] [${severity}] ${message}`);

    if (this.alerts.length > 200) this.alerts.shift(); // Keep last 200 alerts
  }

  public getAlerts(): AlertRecord[] {
    return [ ...this.alerts ];
  }

  public clearAlerts() {
    this.alerts = [];
  }

  /**
   * Compiles diagnostic performance metrics.
   */
  public getSnapshot(): MetricSnapshot {
    const avgOms = this.omsLatencies.length > 0
      ? Math.round(this.omsLatencies.reduce((a, b) => a + b, 0) / this.omsLatencies.length)
      : 0;

    const avgRecon = this.reconLatencies.length > 0
      ? Math.round(this.reconLatencies.reduce((a, b) => a + b, 0) / this.reconLatencies.length)
      : 0;

    return {
      tickThroughput: this.totalTicksProcessed,
      avgOmsLatencyMs: avgOms,
      avgReconLatencyMs: avgRecon,
      reconMismatchesCount: this.reconMismatches,
      activeAlertsCount: this.alerts.length,
    };
  }

  /**
   * Formulates Prometheus-compliant metric scrapable text payload.
   */
  public scrapeMetrics(): string {
    const snapshot = this.getSnapshot();
    return `# HELP trading_ticks_processed_total Total price tick events processed
# TYPE trading_ticks_processed_total counter
trading_ticks_processed_total ${snapshot.tickThroughput}

# HELP trading_oms_latency_ms Average latency of the OMS placement execution
# TYPE trading_oms_latency_ms gauge
trading_oms_latency_ms ${snapshot.avgOmsLatencyMs}

# HELP trading_reconciliation_latency_ms Average latency of the bidirectional reconciliation loops
# TYPE trading_reconciliation_latency_ms gauge
trading_reconciliation_latency_ms ${snapshot.avgReconLatencyMs}

# HELP trading_reconciliation_mismatches_total Total identified state mismatches
# TYPE trading_reconciliation_mismatches_total counter
trading_reconciliation_mismatches_total ${snapshot.reconMismatchesCount}

# HELP trading_active_alerts Active warning or critical system alerts
# TYPE trading_active_alerts gauge
trading_active_alerts ${snapshot.activeAlertsCount}
`;
  }
}

export const observabilityStack = ObservabilityStack.getInstance();
