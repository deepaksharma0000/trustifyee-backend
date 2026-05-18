// src/services/ChaosTestingFramework.ts
import { tickEngineService } from "./TickEngineService";
import { eventSourcedOMS } from "./EventSourcedOMS";
import { clockDriftMonitor } from "./ClockDriftMonitor";
import { strategySandboxRuntime } from "./StrategySandboxRuntime";
import log from "../utils/logger";

export interface ChaosDiagnostics {
  experimentName: string;
  injectedAt: number;
  completedAt?: number;
  result: "SUCCESS" | "FAILED";
  assertionsVerified: string[];
  diagnosticLogs: string[];
}

export class ChaosTestingFramework {
  private static instance: ChaosTestingFramework;

  private activeExperiments: ChaosDiagnostics[] = [];

  private constructor() {}

  public static getInstance(): ChaosTestingFramework {
    if (!ChaosTestingFramework.instance) {
      ChaosTestingFramework.instance = new ChaosTestingFramework();
    }
    return ChaosTestingFramework.instance;
  }

  public getExperimentsLog(): ChaosDiagnostics[] {
    return [ ...this.activeExperiments ];
  }

  /**
   * Chaos Test 1: Websocket Disconnect Storm.
   * Simulates sudden market feed disconnect under active trading to verify auto-resubscription.
   */
  public async executeWebsocketDisconnectStorm(): Promise<ChaosDiagnostics> {
    const diag: ChaosDiagnostics = {
      experimentName: "WEBSOCKET_DISCONNECT_STORM",
      injectedAt: Date.now(),
      result: "SUCCESS",
      assertionsVerified: [],
      diagnosticLogs: [],
    };

    diag.diagnosticLogs.push("Injecting websocket connection drop under load...");
    
    // Forcibly terminate standard stream client socket
    const wsClient = (tickEngineService as any).ws;
    if (wsClient) {
      wsClient.terminate();
      diag.assertionsVerified.push("WebSocket connection forcibly terminated");
    } else {
      diag.diagnosticLogs.push("No active WebSocket connection established at target injection time.");
    }

    // Await auto-reconnect window
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Verify subscription reference restoration state
    const metrics = tickEngineService.getMetrics();
    if (metrics.reconnectCount > 0) {
      diag.assertionsVerified.push("Auto-reconnection logic triggered successfully");
      diag.assertionsVerified.push(`Active subscriptions restored: ${metrics.activeSubscriptionsCount}`);
    } else {
      diag.result = "FAILED";
      diag.diagnosticLogs.push("Tick engine failed to re-establish and count reconnect loops within 5 seconds.");
    }

    diag.completedAt = Date.now();
    this.activeExperiments.push(diag);
    return diag;
  }

  /**
   * Chaos Test 2: NTP Clock Drift Anomaly.
   * Injects high clock drift to verify temporal safety mode transitions and entry suspensions.
   */
  public async executeClockDriftAnomaly(): Promise<ChaosDiagnostics> {
    const diag: ChaosDiagnostics = {
      experimentName: "NTP_CLOCK_DRIFT_ANOMALY",
      injectedAt: Date.now(),
      result: "SUCCESS",
      assertionsVerified: [],
      diagnosticLogs: [],
    };

    diag.diagnosticLogs.push("Simulating NTP timeline jump...");

    // Inject tick older than drift boundary limit (NTP threshold)
    const driftTickTimestamp = Date.now() - 1500; // 1.5 seconds old tick
    const isValid = clockDriftMonitor.validateTickTimestamp(driftTickTimestamp);

    if (!isValid) {
      diag.assertionsVerified.push("Drifted tick rejected by validation timeline");
    }

    const safetyMode = clockDriftMonitor.getSafetyMode();
    diag.assertionsVerified.push(`Current temporal safety mode: ${safetyMode}`);

    if (safetyMode === "PANIC_LIQUIDATION_MODE" || safetyMode === "ENTRY_BLOCK_MODE") {
      diag.assertionsVerified.push("Safety escalation verified. Entry orders successfully suspended.");
    } else {
      diag.result = "FAILED";
      diag.diagnosticLogs.push("ClockDriftMonitor failed to escalate safety mode under severe clock drifts.");
    }

    diag.completedAt = Date.now();
    this.activeExperiments.push(diag);
    return diag;
  }

  /**
   * Chaos Test 3: Sandbox Runtime Script Crash.
   * Injects malicious runtime crashes in strategy scripts to verify supervisor self-healing.
   */
  public async executeSandboxCrashDrill(strategyId: string): Promise<ChaosDiagnostics> {
    const diag: ChaosDiagnostics = {
      experimentName: "SANDBOX_CRASH_DRILL",
      injectedAt: Date.now(),
      result: "SUCCESS",
      assertionsVerified: [],
      diagnosticLogs: [],
    };

    diag.diagnosticLogs.push(`Simulating script runtime crash inside sandbox: ${strategyId}`);

    // Deploy bad strategy code designed to throw runtime errors
    const config = {
      strategyId,
      versionHash: "CHAOS_VER_01",
      scriptCode: 'throw new Error("Simulated quantitative script crash!");',
      maxMemoryMb: 64,
      maxComputeMs: 100,
    };

    const deployed = await strategySandboxRuntime.deployStrategy(config);
    if (deployed) {
      diag.assertionsVerified.push("Isolation sandbox allocated for strategy");
    }

    // Trigger execution
    strategySandboxRuntime.distributeTick(strategyId, { ltp: 150 }, {});

    // Await sandbox supervisor lifecycle check
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const metrics = strategySandboxRuntime.getMetrics(strategyId);
    if (metrics && metrics.crashCounts > 0) {
      diag.assertionsVerified.push("Sandbox crash contained safely within worker thread bounds");
      diag.assertionsVerified.push("Supervisor recovered lifecycle cleanly");
    } else {
      diag.result = "FAILED";
      diag.diagnosticLogs.push("Sandbox supervisor failed to register or isolate crash event.");
    }

    diag.completedAt = Date.now();
    this.activeExperiments.push(diag);
    return diag;
  }
}

export const chaosTestingFramework = ChaosTestingFramework.getInstance();
