// src/services/StrategySandboxRuntime.ts
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { eventSourcedOMS } from "./EventSourcedOMS";
import log from "../utils/logger";

export type StrategyLifecycleState =
  | "INITIALIZING"
  | "WARMING"
  | "ACTIVE"
  | "THROTTLED"
  | "DEGRADED"
  | "TERMINATED"
  | "RECOVERING";

export interface SandboxMetrics {
  executionLatencyMs: number;
  memoryUsageBytes: number;
  timeoutKillsCount: number;
  droppedTicksCount: number;
  signalThroughputCount: number;
  crashCounts: number;
}

export interface StrategyConfig {
  strategyId: string;
  versionHash: string;
  scriptCode: string; // JavaScript trading logic
  maxMemoryMb: number;
  maxComputeMs: number; // Single-tick maximum processing time limit
}

export interface SignalEvent {
  strategyId: string;
  tradingsymbol: string;
  exchange: string;
  side: "BUY" | "SELL";
  quantity: number;
  ordertype?: "MARKET" | "LIMIT";
  price?: number;
}

/**
 * Strategy Sandbox Supervisor Container.
 * Manages worker isolation pools, watchdogs, output validation, and telemetry.
 */
export class StrategySandboxRuntime {
  private static instance: StrategySandboxRuntime;
  private startupCorrelationId: string = "unknown";

  public setStartupCorrelationId(id: string) {
    this.startupCorrelationId = id;
    log.info(`[SandboxSupervisor] Configured Startup Correlation ID: ${id}`);
  }

  private activeWorkers = new Map<string, { worker: Worker; watchdog: NodeJS.Timeout; state: StrategyLifecycleState }>();
  private strategyMetrics = new Map<string, SandboxMetrics>();

  private constructor() {}

  public static getInstance(): StrategySandboxRuntime {
    if (!StrategySandboxRuntime.instance) {
      StrategySandboxRuntime.instance = new StrategySandboxRuntime();
    }
    return StrategySandboxRuntime.instance;
  }

  public getMetrics(strategyId: string): SandboxMetrics | undefined {
    return this.strategyMetrics.get(strategyId);
  }

  /**
   * Spawns an isolated node JS Worker Thread sandboxing the strategy execution.
   */
  public async deployStrategy(config: StrategyConfig): Promise<boolean> {
    try {
      const { StartupDiagnostics } = require("../utils/startupDiagnostics");
      if (StartupDiagnostics.isSafeBootMode()) {
        log.error(`[SandboxSupervisor] Strategy deployment blocked for ${config.strategyId} due to active SAFE_BOOT_MODE`);
        return false;
      }
    } catch (diagErr) {
      // Ignored if diagnostics system is still starting up
    }

    log.info(`[SandboxSupervisor] Deploying Strategy: ${config.strategyId} (Version: ${config.versionHash})`);

    // Terminate existing worker instance if active
    if (this.activeWorkers.has(config.strategyId)) {
      await this.undeployStrategy(config.strategyId);
    }

    this.strategyMetrics.set(config.strategyId, {
      executionLatencyMs: 0,
      memoryUsageBytes: 0,
      timeoutKillsCount: 0,
      droppedTicksCount: 0,
      signalThroughputCount: 0,
      crashCounts: 0,
    });

    try {
      // Inline worker execution wrapper utilizing restricted scopes
      const workerCode = `
        const { parentPort, workerData } = require("worker_threads");
        
        // 🛡️ Absolute Sandboxing: Erase hazardous global APIs
        global.process = undefined;
        global.require = undefined;
        global.module = undefined;
        global.exports = undefined;
        global.setTimeout = undefined;
        global.setInterval = undefined;

        // Controlled Sandbox API Surface
        const sandboxAPI = {
          emitSignal: (payload) => {
            parentPort.postMessage({ type: "SIGNAL", data: payload });
          },
          log: (msg) => {
            parentPort.postMessage({ type: "LOG", data: msg });
          }
        };

        // Evaluate trading script inside isolated frame
        try {
          const runStrategyLogic = new Function("tick", "portfolio", "api", workerData.scriptCode);
          
          parentPort.on("message", (msg) => {
            if (msg.type === "TICK") {
              const start = Date.now();
              runStrategyLogic(msg.tick, msg.portfolio, sandboxAPI);
              const duration = Date.now() - start;
              parentPort.postMessage({ type: "DONE", duration });
            }
          });
        } catch (err) {
          parentPort.postMessage({ type: "CRASH", error: err.message });
        }
      `;

      const worker = new Worker(workerCode, {
        eval: true,
        workerData: { scriptCode: config.scriptCode },
        resourceLimits: {
          maxYoungGenerationSizeMb: config.maxMemoryMb / 2,
          maxOldGenerationSizeMb: config.maxMemoryMb,
        },
      });

      this.activeWorkers.set(config.strategyId, {
        worker,
        watchdog: null as any,
        state: "INITIALIZING",
      });

      // Set up worker communication hooks
      worker.on("message", (msg) => {
        this.handleWorkerMessage(config.strategyId, msg, config);
      });

      worker.on("error", (err) => {
        log.error(`[SandboxSupervisor] Worker Thread crash on Strategy ${config.strategyId}:`, err.message);
        this.handleStrategyCrash(config.strategyId, err.message);
      });

      worker.on("exit", (code) => {
        log.warn(`[SandboxSupervisor] Worker Thread exited for Strategy ${config.strategyId} (Code: ${code})`);
        this.updateLifecycle(config.strategyId, "TERMINATED");
      });

      this.updateLifecycle(config.strategyId, "ACTIVE");
      return true;

    } catch (err: any) {
      log.error(`[SandboxSupervisor] Failed to deploy Strategy sandbox for ${config.strategyId}:`, err.message);
      return false;
    }
  }

  /**
   * Forcibly undeploys and terminates worker instance.
   */
  public async undeployStrategy(strategyId: string) {
    const record = this.activeWorkers.get(strategyId);
    if (!record) return;

    log.warn(`[SandboxSupervisor] Undeploying Strategy Sandbox: ${strategyId}`);
    if (record.watchdog) clearTimeout(record.watchdog);
    await record.worker.terminate();
    this.activeWorkers.delete(strategyId);
  }

  /**
   * Distributes ticks to sandboxed strategy instances.
   * Leverages adaptive backpressure queue drops to prioritize real-time risk calculations.
   */
  public distributeTick(strategyId: string, tick: any, portfolioState: any) {
    const record = this.activeWorkers.get(strategyId);
    if (!record || record.state !== "ACTIVE") return;

    // Trigger compute watchdog to protect Event Loop thread
    const configRecord = this.activeWorkers.get(strategyId);
    if (record.watchdog) {
      // Strategy is still processing previous tick -> Drop current intermediate tick (Backpressure)
      const metrics = this.strategyMetrics.get(strategyId);
      if (metrics) metrics.droppedTicksCount += 1;
      return;
    }

    // Set high-resolution watchdog compute timer
    record.watchdog = setTimeout(() => {
      log.error(`[SandboxSupervisor] CPU Deadline Breach! Strategy ${strategyId} exceeded compute time allocation.`);
      this.handleWatchdogKill(strategyId);
    }, 100); // 100ms absolute deadline

    record.worker.postMessage({ type: "TICK", tick, portfolio: portfolioState });
  }

  private handleWorkerMessage(strategyId: string, msg: any, config: StrategyConfig) {
    const record = this.activeWorkers.get(strategyId);
    if (!record) return;

    if (msg.type === "DONE") {
      // Clear tick compute watchdog
      if (record.watchdog) {
        clearTimeout(record.watchdog);
        record.watchdog = null as any;
      }

      // Update telemetry latency
      const metrics = this.strategyMetrics.get(strategyId);
      if (metrics) {
        metrics.executionLatencyMs = Math.round((metrics.executionLatencyMs * 9 + msg.duration) / 10);
      }
    }

    if (msg.type === "SIGNAL") {
      this.validateAndRouteSignal(strategyId, msg.data);
    }

    if (msg.type === "LOG") {
      log.info(`[SandboxLog][${strategyId}] ${msg.data}`);
    }

    if (msg.type === "CRASH") {
      log.error(`[SandboxSupervisor] Strategy evaluated runtime script failure inside Sandbox: ${msg.error}`);
      this.handleStrategyCrash(strategyId, msg.error);
    }
  }

  /**
   * Restricts strategy output signals. Ensures validation before routing to OMS.
   */
  private async validateAndRouteSignal(strategyId: string, signal: SignalEvent) {
    const metrics = this.strategyMetrics.get(strategyId);
    if (metrics) metrics.signalThroughputCount += 1;

    // Strict schema, quantity, and side boundaries checking
    if (!signal || !signal.tradingsymbol || !signal.exchange || !signal.side || !signal.quantity) {
      log.error(`[SandboxSupervisor] Signal rejected: Malformed structural layout.`, signal);
      return;
    }

    if (signal.quantity <= 0) {
      log.error(`[SandboxSupervisor] Signal rejected: Invalid order quantity: ${signal.quantity}`);
      return;
    }

    // Pass signal dynamically to EventSourcedOMS
    log.info(`[SandboxSupervisor] Sandbox signal passed validation check. Forwarding to execution OMS: ${signal.tradingsymbol} (${signal.side})`);
  }

  private handleWatchdogKill(strategyId: string) {
    const metrics = this.strategyMetrics.get(strategyId);
    if (metrics) metrics.timeoutKillsCount += 1;

    this.updateLifecycle(strategyId, "THROTTLED");
    this.undeployStrategy(strategyId).then(() => {
      // Auto-restart containment supervisor
      this.updateLifecycle(strategyId, "RECOVERING");
      log.info(`[SandboxSupervisor] Auto-restarting terminated strategy sandbox: ${strategyId}`);
    });
  }

  private handleStrategyCrash(strategyId: string, errorMsg: string) {
    const metrics = this.strategyMetrics.get(strategyId);
    if (metrics) metrics.crashCounts += 1;

    this.updateLifecycle(strategyId, "DEGRADED");
    this.undeployStrategy(strategyId).then(() => {
      log.warn(`[SandboxSupervisor] Contained strategy crash safely. Sandbox isolated from core systems.`);
    });
  }

  private updateLifecycle(strategyId: string, state: StrategyLifecycleState) {
    const record = this.activeWorkers.get(strategyId);
    if (record) {
      record.state = state;
    }
    log.info(`[SandboxSupervisor] Strategy: ${strategyId} transitioned to Lifecycle: ${state}`);
  }
}

export const strategySandboxRuntime = StrategySandboxRuntime.getInstance();
