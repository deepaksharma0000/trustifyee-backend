import mongoose from "mongoose";
import Redis from "ioredis";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import log from "./logger";
import { config } from "../config";
import redisConnection from "./redis";
import StartupTelemetryModel from "../models/StartupTelemetry";

export enum StartupState {
  BOOTING = "BOOTING",
  DEPENDENCY_CHECK = "DEPENDENCY_CHECK",
  DEGRADED_STARTUP = "DEGRADED_STARTUP",
  READY = "READY",
  FAILED = "FAILED",
}

export enum ComponentStatus {
  HEALTHY = "HEALTHY",
  DEGRADED = "DEGRADED",
  FAILED = "FAILED",
}

export enum SystemStatus {
  HEALTHY = "HEALTHY",
  DEGRADED = "DEGRADED",
  FAILED = "FAILED",
}

export interface ComponentHealthState {
  readonly status: ComponentStatus;
  readonly latencyMs: number;
  readonly retryCount: number;
  readonly errorTraces: readonly string[];
  readonly timestamp: number;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly sequencingOrder: number;
}

export interface ComponentRegistry {
  readonly mongo: ComponentHealthState;
  readonly redis: ComponentHealthState;
  readonly bullmq: ComponentHealthState;
  readonly disk: ComponentHealthState;
  readonly timezone: ComponentHealthState;
  readonly websocket: ComponentHealthState;
  readonly oms: ComponentHealthState;
  readonly routeWhitelist: ComponentHealthState;
}

export interface ImmutableDiagnosticsSnapshot {
  readonly systemStatus: SystemStatus;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly components: ComponentRegistry;
  readonly redisVersion: string;
  readonly isBullMqCompatible: boolean;
  readonly publicIpAddress: string;
  readonly totalMongoRetries: number;
  readonly startupFailures: readonly string[];
  integritySignature?: string; // SHA256 signature for integrity verification
}

export interface StartupMetrics {
  startupDurationMs: number;
  dependencyLatencyMs: Record<string, number>;
  reconnectAttempts: number;
  redisRttMs: number;
  mongoRttMs: number;
  startupFailures: string[];
}

export interface InfrastructureTelemetryEvent {
  eventId: string;
  correlationId: string;
  eventType: "CHECK_STARTED" | "CHECK_COMPLETED" | "CHECK_DEGRADED" | "CHECK_FAILED" | "INVARIANT_VIOLATION" | "SHUTDOWN_TRIGGERED";
  subsystem: string;
  timestamp: number;
  metadata: Record<string, any>;
  signature: string; // SHA256 hash verifying telemetry payload integrity
}

export class StartupDiagnostics {
  // 1. Distributed Correlation ID & Safety State
  public static correlationId: string = "unknown";
  private static safeBootModeActive: boolean = false;

  public static detectedOutboundIp: string = "UNKNOWN";
  public static whitelistMatch: boolean = true;
  public static whitelistMismatchExists: boolean = false;

  // Legacy fields
  public static state: StartupState = StartupState.BOOTING;
  public static startTime: number = Date.now();
  
  public static metrics: StartupMetrics = {
    startupDurationMs: 0,
    dependencyLatencyMs: {},
    reconnectAttempts: 0,
    redisRttMs: -1,
    mongoRttMs: -1,
    startupFailures: [],
  };

  public static isBullMqCompatible: boolean = true;
  public static redisVersion: string = "unknown";
  public static publicIpAddress: string = "unknown";

  // Deeply frozen snapshot registry
  private static finalSnapshot: ImmutableDiagnosticsSnapshot | null = null;
  
  // In-Memory Telemetry Event Stream Buffer
  public static events: InfrastructureTelemetryEvent[] = [];

  /**
   * Helper to recursively freeze any object to prevent downstream/asynchronous mutations.
   */
  private static deepFreeze<T>(obj: T): T {
    if (obj === null || typeof obj !== "object") {
      return obj;
    }
    Object.freeze(obj);
    Object.getOwnPropertyNames(obj).forEach((prop) => {
      const value = (obj as any)[prop];
      if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        StartupDiagnostics.deepFreeze(value);
      }
    });
    return obj;
  }

  /**
   * Generates a deterministic startup correlation ID based on PID, hostname, boot time, and environment parameters.
   */
  public static generateCorrelationId(): string {
    const hostname = require("os").hostname() || "localhost";
    const ts = Date.now().toString();
    const cleanSeed = `${process.pid}:${hostname}:${ts}:${process.version}`;
    
    StartupDiagnostics.correlationId = "STARTUP-CID-" + crypto
      .createHash("sha256")
      .update(cleanSeed)
      .digest("hex")
      .substring(0, 16)
      .toUpperCase();

    log.info(`[TELEMETRY] Generated Deterministic Startup Correlation ID: ${StartupDiagnostics.correlationId}`);
    return StartupDiagnostics.correlationId;
  }

  /**
   * Propagates the startup correlation ID across all 8 microservices/boundaries in a crash-proof manner.
   */
  public static async propagateCorrelationId(id: string): Promise<void> {
    log.info(`[TELEMETRY] Propagating Startup Correlation ID to all microservices...`);

    // 1. OMS
    try {
      const { eventSourcedOMS } = require("../services/EventSourcedOMS");
      if (eventSourcedOMS && typeof eventSourcedOMS.setStartupCorrelationId === "function") {
        eventSourcedOMS.setStartupCorrelationId(id);
      }
    } catch (e: any) {
      log.warn(`[TELEMETRY] OMS propagation skipped or failed: ${e.message}`);
    }

    // 2. TickEngine
    try {
      const { tickEngineService } = require("../services/TickEngineService");
      if (tickEngineService && typeof tickEngineService.setStartupCorrelationId === "function") {
        tickEngineService.setStartupCorrelationId(id);
      }
    } catch (e: any) {
      log.warn(`[TELEMETRY] TickEngine propagation skipped or failed: ${e.message}`);
    }

    // 3. Redis
    try {
      if (redisConnection && redisConnection.status === "ready") {
        await redisConnection.set("infra:startup:current_correlation_id", id);
        log.info(`[TELEMETRY] Redis correlation key configured successfully`);
      } else {
        log.warn(`[TELEMETRY] Redis connection not ready; correlation key buffered internally`);
      }
    } catch (e: any) {
      log.warn(`[TELEMETRY] Redis key configuration failed: ${e.message}`);
    }

    // 4. BullMQ
    try {
      const { setStartupCorrelationId } = require("./tradeQueue");
      if (typeof setStartupCorrelationId === "function") {
        setStartupCorrelationId(id);
      }
    } catch (e: any) {
      log.warn(`[TELEMETRY] BullMQ propagation failed: ${e.message}`);
    }

    // 5. RiskEngine
    try {
      const { realTimeRiskEngine } = require("../services/RealTimeRiskEngine");
      if (realTimeRiskEngine && typeof realTimeRiskEngine.setStartupCorrelationId === "function") {
        realTimeRiskEngine.setStartupCorrelationId(id);
      }
    } catch (e: any) {
      log.warn(`[TELEMETRY] RiskEngine propagation failed: ${e.message}`);
    }

    // 6. ReconciliationService
    try {
      const { reconciliationService } = require("../services/ReconciliationService");
      if (reconciliationService && typeof reconciliationService.setStartupCorrelationId === "function") {
        reconciliationService.setStartupCorrelationId(id);
      }
    } catch (e: any) {
      log.warn(`[TELEMETRY] ReconciliationService propagation failed: ${e.message}`);
    }

    // 7. SessionAuthority
    try {
      const { sessionAuthority } = require("../services/SessionAuthority");
      if (sessionAuthority && typeof sessionAuthority.setStartupCorrelationId === "function") {
        sessionAuthority.setStartupCorrelationId(id);
      }
    } catch (e: any) {
      log.warn(`[TELEMETRY] SessionAuthority propagation failed: ${e.message}`);
    }

    // 8. SandboxRuntime
    try {
      const { strategySandboxRuntime } = require("../services/StrategySandboxRuntime");
      if (strategySandboxRuntime && typeof strategySandboxRuntime.setStartupCorrelationId === "function") {
        strategySandboxRuntime.setStartupCorrelationId(id);
      }
    } catch (e: any) {
      log.warn(`[TELEMETRY] SandboxRuntime propagation failed: ${e.message}`);
    }
  }

  /**
   * Emits a structured telemetry event, calculates an SHA256 integrity signature, and publishes to Redis Streams (XADD).
   */
  public static async emitEvent(
    eventType: InfrastructureTelemetryEvent["eventType"],
    subsystem: string,
    metadata: Record<string, any> = {}
  ): Promise<void> {
    const timestamp = Date.now();
    const eventId = `EVT-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    
    // Generate deterministic integrity hash signature
    const signaturePayload = JSON.stringify({
      eventId,
      correlationId: StartupDiagnostics.correlationId,
      eventType,
      subsystem,
      timestamp,
      metadata,
    });
    const signature = crypto.createHash("sha256").update(signaturePayload).digest("hex");

    const event: InfrastructureTelemetryEvent = {
      eventId,
      correlationId: StartupDiagnostics.correlationId,
      eventType,
      subsystem,
      timestamp,
      metadata,
      signature,
    };

    // Store in-memory buffer
    StartupDiagnostics.events.push(event);

    // Format logs appropriately
    const message = `[TELEMETRY][${eventType}][${subsystem.toUpperCase()}] ${JSON.stringify(metadata)}`;
    if (eventType === "CHECK_FAILED" || eventType === "INVARIANT_VIOLATION") {
      log.error(message);
    } else if (eventType === "CHECK_DEGRADED") {
      log.warn(message);
    } else {
      log.info(message);
    }

    // Publish to Redis Streams (XADD) safely (isolation guard)
    try {
      if (redisConnection && redisConnection.status === "ready") {
        const flatArray: string[] = [];
        for (const [k, v] of Object.entries(event)) {
          flatArray.push(k, typeof v === "object" ? JSON.stringify(v) : String(v));
        }
        await redisConnection.xadd("infra:startup:audit", "*", ...flatArray);
      }
    } catch (streamErr: any) {
      log.warn(`[TELEMETRY] Skipped publishing event to Redis Streams (Redis offline/recovering): ${streamErr.message}`);
    }
  }

  /**
   * Startup Safety Mode / Circuit Breaker status
   */
  public static isSafeBootMode(): boolean {
    return StartupDiagnostics.safeBootModeActive;
  }

  /**
   * Evaluates historical boots to determine if the circuit breaker threshold has been breached.
   */
  private static async evaluateCircuitBreaker(): Promise<void> {
    log.info("[CIRCUIT_BREAKER] Evaluating startup diagnostics history...");
    const history = StartupDiagnostics.loadHistory();
    if (history.length === 0) return;

    // Check last 5 boots
    const windowSize = Math.min(history.length, 5);
    const lastBoots = history.slice(-windowSize);
    const failedBoots = lastBoots.filter((b: any) => b.status === "FAILED").length;

    log.info(`[CIRCUIT_BREAKER] Startup statistics: ${failedBoots}/${windowSize} consecutive failures detected.`);

    // If 3 or more failed boots in the last 5 attempts, trigger SAFE_BOOT_MODE
    if (failedBoots >= 3) {
      StartupDiagnostics.safeBootModeActive = true;
      await StartupDiagnostics.emitEvent("SHUTDOWN_TRIGGERED", "system", {
        reason: "SAFE_BOOT_MODE_ENGAGED",
        description: `Startup failure frequency (${failedBoots}/${windowSize}) breached reliability safety margins. Safe boot locks active.`,
      });
      log.error("[CIRCUIT_BREAKER] CRITICAL: SAFE_BOOT_MODE HAS BEEN TRIGGERED! Trading engine is locked down. Non-critical background workflows are disabled.");
    } else {
      StartupDiagnostics.safeBootModeActive = false;
      log.info("[CIRCUIT_BREAKER] System boot sequence verified within safe operating tolerances.");
    }
  }

  /**
   * Persists startup telemetry timeseries run both offline-first (local JSON) and in MongoDB.
   */
  private static async persistTelemetry(run: any): Promise<void> {
    // 1. Offline JSON persistence
    StartupDiagnostics.saveHistory(run);

    // 2. Mongoose timeseries persistence
    try {
      if (mongoose.connection.readyState === 1) {
        await StartupTelemetryModel.create(run);
        log.info(`[TELEMETRY] Successfully archived boot telemetry details inside MongoDB timeseries collection`);
      } else {
        log.warn(`[TELEMETRY] MongoDB offline; metrics buffered in offline-first storage`);
      }
    } catch (dbErr: any) {
      log.error(`[TELEMETRY] Failed to write metrics to MongoDB: ${dbErr.message}`);
    }
  }

  private static loadHistory(): any[] {
    const historyPath = path.join(process.cwd(), "artifacts", "startup_telemetry_history.json");
    if (fs.existsSync(historyPath)) {
      try {
        return JSON.parse(fs.readFileSync(historyPath, "utf8"));
      } catch {
        return [];
      }
    }
    return [];
  }

  private static saveHistory(run: any): void {
    const historyPath = path.join(process.cwd(), "artifacts", "startup_telemetry_history.json");
    const history = StartupDiagnostics.loadHistory();
    history.push(run);
    
    // Cap historical trace ledger to last 100 entries to optimize volatility calculation performance
    if (history.length > 100) {
      history.shift();
    }

    const dir = path.dirname(historyPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf8");
  }

  /**
   * Calculates metrics drift analytics and standard deviation volatility from boot history ledger.
   */
  public static calculateDriftAnalytics(): Record<string, any> {
    const history = StartupDiagnostics.loadHistory();
    if (history.length === 0) {
      return {
        avgMongoRtt: -1,
        avgRedisRtt: -1,
        startupVolatility: 0,
        dependencyWarmupDuration: 0,
      };
    }

    const mRtts = history.map((h) => h.mongoRttMs).filter((v) => v >= 0);
    const rRtts = history.map((h) => h.redisRttMs).filter((v) => v >= 0);
    const durations = history.map((h) => h.startupDurationMs || h.durationMs).filter((v) => v >= 0);

    const avgMongoRtt = mRtts.length > 0 ? mRtts.reduce((a, b) => a + b, 0) / mRtts.length : -1;
    const avgRedisRtt = rRtts.length > 0 ? rRtts.reduce((a, b) => a + b, 0) / rRtts.length : -1;
    
    // Standard deviation volatility calculation
    let stdDev = 0;
    if (durations.length > 0) {
      const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
      const variance = durations.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / durations.length;
      stdDev = Math.sqrt(variance);
    }

    return {
      avgMongoRtt: Math.round(avgMongoRtt * 100) / 100,
      avgRedisRtt: Math.round(avgRedisRtt * 100) / 100,
      startupVolatility: Math.round(stdDev * 100) / 100,
      dependencyWarmupDuration: history[history.length - 1]?.startupDurationMs || 0,
    };
  }

  /**
   * Generates failure heatmaps aggregating unstable subsystems and failure rates.
   */
  public static generateHeatmaps(): Record<string, any> {
    const history = StartupDiagnostics.loadHistory();
    if (history.length === 0) {
      return {
        mostUnstableDependency: "none",
        avgRetryCounts: 0,
        degradedSubsystemFrequency: {},
      };
    }

    const totalBoots = history.length;
    const failuresMap: Record<string, number> = {};
    const degradedMap: Record<string, number> = {};
    let totalRetries = 0;

    history.forEach((run) => {
      totalRetries += run.reconnectAttempts || 0;
      if (run.failures && Array.isArray(run.failures)) {
        run.failures.forEach((f: string) => {
          const match = f.match(/^(\w+)(Connection|Validation|Error)/i);
          const subsystem = match ? match[1].toLowerCase() : "unknown";
          failuresMap[subsystem] = (failuresMap[subsystem] || 0) + 1;
        });
      }
      if (run.components) {
        Object.entries(run.components).forEach(([k, v]: [string, any]) => {
          if (v.status === "DEGRADED") {
            degradedMap[k] = (degradedMap[k] || 0) + 1;
          }
          if (v.status === "FAILED") {
            failuresMap[k] = (failuresMap[k] || 0) + 1;
          }
        });
      }
    });

    let mostUnstableDependency = "none";
    let maxFailures = 0;
    Object.entries(failuresMap).forEach(([k, v]) => {
      if (v > maxFailures) {
        maxFailures = v;
        mostUnstableDependency = k;
      }
    });

    return {
      mostUnstableDependency,
      avgRetryCounts: Math.round((totalRetries / totalBoots) * 100) / 100,
      degradedSubsystemFrequency: degradedMap,
    };
  }

  // ==========================================
  // ISOLATED DETERMINISTIC COMPONENT CHECKERS
  // ==========================================

  private static async runTimezoneCheck(order: number): Promise<ComponentHealthState> {
    const startedAt = Date.now();
    await StartupDiagnostics.emitEvent("CHECK_STARTED", "timezone", { order });
    let status = ComponentStatus.HEALTHY;
    const errorTraces: string[] = [];

    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const isIst = tz === "Asia/Kolkata";
      if (!isIst) {
        status = ComponentStatus.DEGRADED;
        errorTraces.push(`Timezone drift check failed. Host timezone set to: ${tz}. Expected: Asia/Kolkata`);
        await StartupDiagnostics.emitEvent("CHECK_DEGRADED", "timezone", {
          error: `System timezone is set to "${tz}". Standard trading operations run on "Asia/Kolkata". Please align timezone if scheduling accuracy fails.`,
        });
      } else {
        await StartupDiagnostics.emitEvent("CHECK_COMPLETED", "timezone", { details: "Asia/Kolkata aligned" });
      }
    } catch (err: any) {
      status = ComponentStatus.FAILED;
      errorTraces.push(`TimezoneError: ${err.message}`);
      await StartupDiagnostics.emitEvent("CHECK_FAILED", "timezone", { error: err.message });
    }

    const endedAt = Date.now();
    return Object.freeze({
      status,
      latencyMs: 0,
      retryCount: 1,
      errorTraces: Object.freeze(errorTraces),
      timestamp: Date.now(),
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      sequencingOrder: order,
    });
  }

  private static async runDiskCheck(order: number): Promise<ComponentHealthState> {
    const startedAt = Date.now();
    await StartupDiagnostics.emitEvent("CHECK_STARTED", "disk", { order });
    let status = ComponentStatus.HEALTHY;
    const errorTraces: string[] = [];
    const testDir = path.join(process.cwd(), "uploads");
    const testFile = path.join(testDir, `.disk-write-test-${Date.now()}`);

    try {
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
      }
      fs.writeFileSync(testFile, "trustifyee-write-test-payload");
      const readBack = fs.readFileSync(testFile, "utf8");
      if (readBack !== "trustifyee-write-test-payload") {
        throw new Error("Read-back verification mismatch.");
      }
      fs.unlinkSync(testFile);
      await StartupDiagnostics.emitEvent("CHECK_COMPLETED", "disk", { status: "VERIFIED" });
    } catch (err: any) {
      status = ComponentStatus.FAILED;
      errorTraces.push(`DiskWriteError: ${err.message}`);
      await StartupDiagnostics.emitEvent("CHECK_FAILED", "disk", { error: err.message });
    }

    const endedAt = Date.now();
    return Object.freeze({
      status,
      latencyMs: endedAt - startedAt,
      retryCount: 1,
      errorTraces: Object.freeze(errorTraces),
      timestamp: Date.now(),
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      sequencingOrder: order,
    });
  }

  private static async runRedisCheck(order: number): Promise<{
    state: ComponentHealthState;
    version: string;
  }> {
    const startedAt = Date.now();
    await StartupDiagnostics.emitEvent("CHECK_STARTED", "redis", { order });
    let status = ComponentStatus.HEALTHY;
    const errorTraces: string[] = [];
    let rtt = -1;
    let version = "unknown";

    let client: Redis | null = null;
    try {
      const { redisBullConnection } = require("./redis");
      
      client = new Redis({
        ...redisBullConnection,
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        connectTimeout: 5000,
      });

      await client.connect();
      
      const pingStart = Date.now();
      const pingResp = await client.ping();
      if (pingResp !== "PONG") {
        throw new Error("Invalid response received from Redis Ping command.");
      }
      rtt = Date.now() - pingStart;

      const info = await client.info("server");
      const versionMatch = info.match(/redis_version:(\S+)/);
      if (versionMatch) {
        version = versionMatch[1];
      }
      
      await StartupDiagnostics.emitEvent("CHECK_COMPLETED", "redis", { rtt, version });
    } catch (err: any) {
      status = ComponentStatus.FAILED;
      errorTraces.push(`RedisValidationError: ${err.message}`);
      await StartupDiagnostics.emitEvent("CHECK_FAILED", "redis", { error: err.message });
    } finally {
      if (client) {
        await client.quit().catch(() => {});
      }
    }

    const endedAt = Date.now();
    return {
      state: Object.freeze({
        status,
        latencyMs: rtt,
        retryCount: 1,
        errorTraces: Object.freeze(errorTraces),
        timestamp: Date.now(),
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        sequencingOrder: order,
      }),
      version,
    };
  }

  private static async runBullMqCheck(
    order: number,
    redisStatus: ComponentStatus,
    redisVersion: string
  ): Promise<{
    state: ComponentHealthState;
    compatible: boolean;
  }> {
    const startedAt = Date.now();
    await StartupDiagnostics.emitEvent("CHECK_STARTED", "bullmq", { order });
    let status = ComponentStatus.HEALTHY;
    const errorTraces: string[] = [];
    let compatible = true;

    if (redisStatus === ComponentStatus.FAILED) {
      status = ComponentStatus.FAILED;
      compatible = false;
      errorTraces.push("BullMQ check skipped: dependent Redis infrastructure is failed.");
      await StartupDiagnostics.emitEvent("CHECK_FAILED", "bullmq", { error: "Dependent Redis failed" });
    } else {
      try {
        if (redisVersion === "unknown") {
          status = ComponentStatus.DEGRADED;
          compatible = false;
          errorTraces.push("Redis version unknown. Degraded compatibility assumed.");
          await StartupDiagnostics.emitEvent("CHECK_DEGRADED", "bullmq", { error: "Redis version unknown" });
        } else {
          const [major, minor] = redisVersion.split(".").map(Number);
          if (major < 5) {
            status = ComponentStatus.FAILED;
            compatible = false;
            errorTraces.push(`Redis version ${redisVersion} is completely unsupported (minimum required: 5.0.0).`);
            await StartupDiagnostics.emitEvent("CHECK_FAILED", "bullmq", { error: `Version ${redisVersion} unsupported` });
          } else if (major < 6 || (major === 6 && minor < 2)) {
            status = ComponentStatus.DEGRADED;
            compatible = false;
            errorTraces.push(`Redis version ${redisVersion} detected. BullMQ requires Redis >= 6.2 for streams. Fallbacks activated.`);
            await StartupDiagnostics.emitEvent("CHECK_DEGRADED", "bullmq", { error: `Version ${redisVersion} triggers fallback` });
          } else {
            await StartupDiagnostics.emitEvent("CHECK_COMPLETED", "bullmq", { compatible: true, redisVersion });
          }
        }
      } catch (err: any) {
        status = ComponentStatus.FAILED;
        compatible = false;
        errorTraces.push(`BullMQCompatibilityError: ${err.message}`);
        await StartupDiagnostics.emitEvent("CHECK_FAILED", "bullmq", { error: err.message });
      }
    }

    const endedAt = Date.now();
    return {
      state: Object.freeze({
        status,
        latencyMs: -1,
        retryCount: 1,
        errorTraces: Object.freeze(errorTraces),
        timestamp: Date.now(),
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        sequencingOrder: order,
      }),
      compatible,
    };
  }

  private static async runMongoCheck(
    order: number,
    maxAttempts = 5,
    initialDelayMs = 1000
  ): Promise<{
    state: ComponentHealthState;
    retryCount: number;
    rtt: number;
  }> {
    const startedAt = Date.now();
    await StartupDiagnostics.emitEvent("CHECK_STARTED", "mongo", { order });
    let status = ComponentStatus.HEALTHY;
    const errorTraces: string[] = [];
    let attempt = 0;
    let delay = initialDelayMs;
    let rtt = -1;

    const rawUri = config.mongoUri;
    const ipv4Uri = this.forceIpv4Uri(rawUri);
    const safeUriLog = ipv4Uri.replace(/:([^:@]+)@/, ":****@");

    while (true) {
      attempt++;
      const attemptStart = Date.now();
      try {
        log.info(`[MONGO] Attempting connection (Attempt ${attempt}/${maxAttempts})...`, { uri: safeUriLog });
        
        await mongoose.connect(ipv4Uri, {
          serverSelectionTimeoutMS: 5000,
        });

        // Measure ping latency
        const pingStart = Date.now();
        await mongoose.connection.db.admin().ping();
        rtt = Date.now() - pingStart;

        await StartupDiagnostics.emitEvent("CHECK_COMPLETED", "mongo", { attempt, rtt });
        break;
      } catch (err: any) {
        const attemptDuration = Date.now() - attemptStart;
        errorTraces.push(`MongoConnectionAttempt_${attempt}_Failed (took ${attemptDuration}ms): ${err.message}`);
        log.error(`[MONGO] Attempt ${attempt}/${maxAttempts} failed in ${attemptDuration}ms: ${err.message}`);

        if (attempt >= maxAttempts) {
          status = ComponentStatus.FAILED;
          await StartupDiagnostics.emitEvent("CHECK_FAILED", "mongo", {
            attempts: attempt,
            error: err.message,
          });
          break;
        }

        log.info(`[MONGO] Backing off. Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2; // Exponential Backoff
      }
    }

    const endedAt = Date.now();
    return {
      state: Object.freeze({
        status,
        latencyMs: rtt,
        retryCount: attempt,
        errorTraces: Object.freeze(errorTraces),
        timestamp: Date.now(),
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        sequencingOrder: order,
      }),
      retryCount: attempt,
      rtt,
    };
  }

  private static async runWebSocketCheck(order: number): Promise<ComponentHealthState> {
    const startedAt = Date.now();
    await StartupDiagnostics.emitEvent("CHECK_STARTED", "websocket", { order });
    let status = ComponentStatus.HEALTHY;
    const errorTraces: string[] = [];

    try {
      const wsModule = require("ws");
      if (!wsModule || !wsModule.Server) {
        throw new Error("Failed to load ws module or Server is missing");
      }
      
      if (!config.port || isNaN(Number(config.port))) {
        throw new Error(`Invalid server port configuration: ${config.port}`);
      }

      await StartupDiagnostics.emitEvent("CHECK_COMPLETED", "websocket", { port: config.port });
    } catch (err: any) {
      status = ComponentStatus.FAILED;
      errorTraces.push(`WebSocketConfigError: ${err.message}`);
      await StartupDiagnostics.emitEvent("CHECK_FAILED", "websocket", { error: err.message });
    }

    const endedAt = Date.now();
    return Object.freeze({
      status,
      latencyMs: 0,
      retryCount: 1,
      errorTraces: Object.freeze(errorTraces),
      timestamp: Date.now(),
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      sequencingOrder: order,
    });
  }

  private static async runOmsCheck(
    order: number,
    mongoStatus: ComponentStatus,
    redisStatus: ComponentStatus
  ): Promise<ComponentHealthState> {
    const startedAt = Date.now();
    await StartupDiagnostics.emitEvent("CHECK_STARTED", "oms", { order });
    let status = ComponentStatus.HEALTHY;
    const errorTraces: string[] = [];

    if (mongoStatus === ComponentStatus.FAILED || redisStatus === ComponentStatus.FAILED) {
      status = ComponentStatus.FAILED;
      if (mongoStatus === ComponentStatus.FAILED) {
        errorTraces.push("OMS check failed: dependent MongoDB infrastructure is failed.");
      }
      if (redisStatus === ComponentStatus.FAILED) {
        errorTraces.push("OMS check failed: dependent Redis infrastructure is failed.");
      }
      await StartupDiagnostics.emitEvent("CHECK_FAILED", "oms", { error: "Dependent infrastructure is failed" });
    } else if (redisStatus === ComponentStatus.DEGRADED) {
      status = ComponentStatus.DEGRADED;
      errorTraces.push("OMS degraded: running in degraded BullMQ mode due to older Redis version.");
      await StartupDiagnostics.emitEvent("CHECK_DEGRADED", "oms", { error: "Running with degraded message queue" });
    } else {
      try {
        const omsModule = require("../services/EventSourcedOMS");
        if (!omsModule || !omsModule.eventSourcedOMS) {
          throw new Error("eventSourcedOMS export not found in EventSourcedOMS service.");
        }
        await StartupDiagnostics.emitEvent("CHECK_COMPLETED", "oms", { details: "OMS ready" });
      } catch (err: any) {
        status = ComponentStatus.FAILED;
        errorTraces.push(`OMSEnvError: ${err.message}`);
        await StartupDiagnostics.emitEvent("CHECK_FAILED", "oms", { error: err.message });
      }
    }

    const endedAt = Date.now();
    return Object.freeze({
      status,
      latencyMs: 0,
      retryCount: 1,
      errorTraces: Object.freeze(errorTraces),
      timestamp: Date.now(),
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      sequencingOrder: order,
    });
  }

  private static async runRouteWhitelistCheck(order: number): Promise<ComponentHealthState> {
    const startedAt = Date.now();
    await StartupDiagnostics.emitEvent("CHECK_STARTED", "routeWhitelist", { order });
    let status = ComponentStatus.HEALTHY;
    const errorTraces: string[] = [];

    try {
      const { detectOutboundIp } = require("./ipService");
      const outboundIp = await detectOutboundIp();
      StartupDiagnostics.detectedOutboundIp = outboundIp;
      
      const configuredIp = (config.publicIp || "").trim();
      
      if (configuredIp) {
        const isMatch = outboundIp === configuredIp;
        StartupDiagnostics.whitelistMatch = isMatch;
        StartupDiagnostics.whitelistMismatchExists = !isMatch;

        if (!isMatch) {
          status = ComponentStatus.DEGRADED;
          const warningMsg = `Broker Whitelist IP Mismatch: Current runtime outbound IP (${outboundIp}) does not match configured broker whitelist IP (${configuredIp}). LIVE execution will be blocked and fall back to PAPER mode automatically!`;
          errorTraces.push(warningMsg);
          log.warn(`[SAFETY_GUARD] ${warningMsg}`);
          
          await StartupDiagnostics.emitEvent("CHECK_DEGRADED", "routeWhitelist", {
            error: warningMsg,
            outboundIp,
            configuredIp,
          });

          const { AlertService } = require("../services/AlertService");
          await AlertService.trigger(
            "WHITELIST_MISMATCH_STARTUP_WARN",
            `CRITICAL: Startup Whitelist IP mismatch detected. Outbound IP is ${outboundIp}, Configured Whitelisted IP is ${configuredIp}. LIVE order execution is automatically disabled.`,
            "CRITICAL"
          );
        } else {
          StartupDiagnostics.whitelistMatch = true;
          StartupDiagnostics.whitelistMismatchExists = false;
          log.info(`[SAFETY_GUARD] Broker Whitelist IP verification succeeded. Outbound IP matches whitelisted IP: ${outboundIp}`);
          await StartupDiagnostics.emitEvent("CHECK_COMPLETED", "routeWhitelist", {
            outboundIp,
            configuredIp,
            match: true,
          });
        }
      } else {
        StartupDiagnostics.whitelistMatch = false;
        StartupDiagnostics.whitelistMismatchExists = true;
        status = ComponentStatus.DEGRADED;
        const warningMsg = "PUBLIC_IP is not configured. Whitelist verification skipped but LIVE execution will be blocked due to missing authorization IP.";
        errorTraces.push(warningMsg);
        log.warn(`[SAFETY_GUARD] ${warningMsg}`);
        await StartupDiagnostics.emitEvent("CHECK_DEGRADED", "routeWhitelist", { error: warningMsg });
      }
    } catch (err: any) {
      status = ComponentStatus.FAILED;
      StartupDiagnostics.whitelistMatch = false;
      StartupDiagnostics.whitelistMismatchExists = true;
      errorTraces.push(`RouteWhitelistCheckError: ${err.message}`);
      await StartupDiagnostics.emitEvent("CHECK_FAILED", "routeWhitelist", { error: err.message });
    }

    const endedAt = Date.now();
    return Object.freeze({
      status,
      latencyMs: endedAt - startedAt,
      retryCount: 1,
      errorTraces: Object.freeze(errorTraces),
      timestamp: Date.now(),
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      sequencingOrder: order,
    });
  }

  public static forceIpv4Uri(uri: string): string {
    if (!uri) return uri;
    try {
      let normalized = uri;
      normalized = normalized.replace("localhost", "127.0.0.1");
      normalized = normalized.replace("[::1]", "127.0.0.1");
      normalized = normalized.replace(/\/\/::1(:|\/)/, "//127.0.0.1$1");
      normalized = normalized.replace(/@::1(:|\/)/, "@127.0.0.1$1");
      return normalized;
    } catch (err: any) {
      log.error("[STARTUP] Failed to force IPv4 URI normalization", err);
      return uri;
    }
  }

  public static validateEnv(): void {
    log.info("[VALIDATOR] Checking environment variables...");
    if (!config.encryptionKey) {
      throw new Error("ENCRYPTION_SECRET environment variable is missing.");
    }
    if (config.encryptionKey.length < 32) {
      throw new Error("ENCRYPTION_SECRET must be at least 32 characters long for production security.");
    }

    const allowedModes = ["USER_ONLY", "SERVER_AUTO", "LOCAL_DEVICE", "SERVER_SHARED_IP", "STATIC_AGENT"];
    if (!allowedModes.includes(config.executionMode)) {
      throw new Error(`EXECUTION_MODE must be one of: ${allowedModes.join(", ")}`);
    }
    log.info("[VALIDATOR] Environment configuration is valid.");
  }

  public static checkAngelOneCredentials(): { ok: boolean; status: string } {
    const hasApiKey = Boolean(config.angelApiKey);
    const hasDataClient = Boolean(config.dataClientCode);
    const hasDataApiKey = Boolean(config.dataApiKey);
    const hasDataPassword = Boolean(config.dataPassword);
    const hasDataTotp = Boolean(config.dataTotpSecret);

    const configured = hasApiKey && hasDataClient && hasDataApiKey && hasDataPassword && hasDataTotp;
    
    if (!configured) {
      const missing: string[] = [];
      if (!hasApiKey) missing.push("ANGEL_API_KEY");
      if (!hasDataClient) missing.push("DATA_CLIENT_CODE");
      if (!hasDataApiKey) missing.push("DATA_API_KEY");
      if (!hasDataPassword) missing.push("DATA_PASSWORD");
      if (!hasDataTotp) missing.push("DATA_TOTP_SECRET");

      const statusMsg = `MISSING_OPTIONAL_GLOBAL_CREDS (${missing.join(", ")})`;
      log.warn(`[VALIDATOR] AngelOne credentials incomplete: ${statusMsg}. (Note: Per-user connection fallback is active)`);
      return { ok: false, status: statusMsg };
    }

    log.info("[VALIDATOR] AngelOne credentials configured successfully.");
    return { ok: true, status: "CONFIGURED" };
  }

  // ==========================================
  // INVARIANT CHECK ENGINE & COMPILER
  // ==========================================

  private static validateInvariants(snapshot: ImmutableDiagnosticsSnapshot): void {
    const c = snapshot.components;

    // 1. Component State Consistency
    for (const key of Object.keys(c) as Array<keyof ComponentRegistry>) {
      const comp = c[key];
      if (comp.status === ComponentStatus.HEALTHY) {
        if (comp.latencyMs < -1) {
          throw new Error(`Invariant Violation: Component ${key} is HEALTHY but has invalid latencyMs: ${comp.latencyMs}`);
        }
      }
      if (comp.status === ComponentStatus.FAILED) {
        if (comp.errorTraces.length === 0) {
          throw new Error(`Invariant Violation: Component ${key} is FAILED but has empty errorTraces.`);
        }
      }
    }

    // 2. Latency Consistency
    if (snapshot.durationMs < 0) {
      throw new Error(`Invariant Violation: System durationMs is negative: ${snapshot.durationMs}`);
    }

    // 3. Dependency State Integrity
    if (c.redis.status === ComponentStatus.FAILED) {
      if (c.bullmq.status !== ComponentStatus.FAILED) {
        throw new Error(`Invariant Violation: Redis is FAILED but BullMQ is not FAILED.`);
      }
      if (c.oms.status !== ComponentStatus.FAILED) {
        throw new Error(`Invariant Violation: Redis is FAILED but OMS is not FAILED.`);
      }
    }

    if (c.mongo.status === ComponentStatus.FAILED) {
      if (c.oms.status !== ComponentStatus.FAILED) {
        throw new Error(`Invariant Violation: MongoDB is FAILED but OMS is not FAILED.`);
      }
    }

    if (snapshot.systemStatus === SystemStatus.HEALTHY) {
      for (const key of Object.keys(c) as Array<keyof ComponentRegistry>) {
        if (c[key].status !== ComponentStatus.HEALTHY) {
          throw new Error(`Invariant Violation: System status is HEALTHY but component ${key} status is ${c[key].status}`);
        }
      }
    }

    if (snapshot.systemStatus === SystemStatus.FAILED) {
      const criticalFail = 
        c.mongo.status === ComponentStatus.FAILED ||
        c.redis.status === ComponentStatus.FAILED ||
        c.disk.status === ComponentStatus.FAILED;
      if (!criticalFail) {
        throw new Error(`Invariant Violation: System status is FAILED but no critical component (mongo, redis, disk) failed.`);
      }
    }
  }

  /**
   * Main audit engine executed at boot.
   */
  public static async runAllChecks(): Promise<void> {
    this.startTime = Date.now();
    this.state = StartupState.DEPENDENCY_CHECK;

    // 1. Generate Deterministic Correlation ID
    const cid = StartupDiagnostics.generateCorrelationId();

    log.info("=========================================================");
    log.info("          STARTING RUNTIME DEPENDENCY AUDIT              ");
    log.info(`          CORRELATION ID: ${cid}`);
    log.info("=========================================================");

    // 2. Evaluate Circuit Breaker historical state BEFORE checking dependencies
    await StartupDiagnostics.evaluateCircuitBreaker();

    // 3. Propagate Correlation ID to all 8 microservice boundaries
    await StartupDiagnostics.propagateCorrelationId(cid);

    let currentOrder = 0;
    
    // Validate Environment Configuration
    try {
      this.validateEnv();
      this.metrics.dependencyLatencyMs["EnvValidation"] = Date.now() - this.startTime;
    } catch (err: any) {
      this.metrics.startupFailures.push(`EnvValidationError: ${err.message}`);
      log.error(`[VALIDATOR] Env validation failed: ${err.message}`);
    }

    // Run Checker Pipelines
    const timezoneState = await this.runTimezoneCheck(++currentOrder);
    const diskState = await this.runDiskCheck(++currentOrder);
    const { state: redisState, version: rVersion } = await this.runRedisCheck(++currentOrder);
    const { state: bullmqState, compatible: bmCompatible } = await this.runBullMqCheck(
      ++currentOrder,
      redisState.status,
      rVersion
    );
    const { state: mongoState, retryCount: mRetries, rtt: mRtt } = await this.runMongoCheck(++currentOrder);
    const websocketState = await this.runWebSocketCheck(++currentOrder);
    const omsState = await this.runOmsCheck(++currentOrder, mongoState.status, redisState.status);
    const routeWhitelistState = await this.runRouteWhitelistCheck(++currentOrder);

    const registry: ComponentRegistry = {
      timezone: timezoneState,
      disk: diskState,
      redis: redisState,
      bullmq: bullmqState,
      mongo: mongoState,
      websocket: websocketState,
      oms: omsState,
      routeWhitelist: routeWhitelistState,
    };

    const endedAt = Date.now();
    const durationMs = endedAt - this.startTime;

    // Determine System Status
    let systemStatus = SystemStatus.HEALTHY;
    if (
      mongoState.status === ComponentStatus.FAILED ||
      redisState.status === ComponentStatus.FAILED ||
      diskState.status === ComponentStatus.FAILED
    ) {
      systemStatus = SystemStatus.FAILED;
    } else if (
      timezoneState.status === ComponentStatus.DEGRADED ||
      bullmqState.status === ComponentStatus.DEGRADED ||
      omsState.status === ComponentStatus.DEGRADED ||
      routeWhitelistState.status === ComponentStatus.DEGRADED
    ) {
      systemStatus = SystemStatus.DEGRADED;
    }

    const failures: string[] = [];
    for (const key of Object.keys(registry) as Array<keyof ComponentRegistry>) {
      const comp = registry[key];
      if (comp.status === ComponentStatus.FAILED) {
        failures.push(...comp.errorTraces);
      }
    }

    // Compile the final snapshot
    let snapshot: ImmutableDiagnosticsSnapshot = {
      systemStatus,
      startedAt: this.startTime,
      endedAt,
      durationMs,
      components: registry,
      redisVersion: rVersion,
      isBullMqCompatible: bmCompatible,
      publicIpAddress: this.publicIpAddress,
      totalMongoRetries: mRetries,
      startupFailures: failures,
    };

    // Calculate SHA256 integrity signature of the snapshot
    const snapshotSignature = crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    (snapshot as any).integritySignature = snapshotSignature;

    this.finalSnapshot = this.deepFreeze(snapshot);

    // Invariant validation
    try {
      this.validateInvariants(this.finalSnapshot);
    } catch (invErr: any) {
      await StartupDiagnostics.emitEvent("INVARIANT_VIOLATION", "system", { error: invErr.message });
      throw invErr;
    }

    this.state = 
      systemStatus === SystemStatus.FAILED 
        ? StartupState.FAILED 
        : systemStatus === SystemStatus.DEGRADED 
        ? StartupState.DEGRADED_STARTUP 
        : StartupState.READY;
    
    this.isBullMqCompatible = bmCompatible;
    this.redisVersion = rVersion;
    
    this.metrics = {
      startupDurationMs: durationMs,
      dependencyLatencyMs: {
        EnvValidation: this.metrics.dependencyLatencyMs["EnvValidation"] || 0,
        Timezone: timezoneState.durationMs,
        DiskWrite: diskState.durationMs,
        Redis: redisState.durationMs,
        BullMQ: bullmqState.durationMs,
        MongoDB: mongoState.durationMs,
        WebSocket: websocketState.durationMs,
        OMS: omsState.durationMs,
        RouteWhitelist: routeWhitelistState.durationMs,
      },
      reconnectAttempts: mRetries,
      redisRttMs: redisState.latencyMs,
      mongoRttMs: mongoState.latencyMs,
      startupFailures: failures,
    };
    Object.freeze(this.metrics);

    // Persist to offline storage & MongoDB
    await StartupDiagnostics.persistTelemetry({
      correlationId: cid,
      timestamp: new Date(this.startTime),
      startupDurationMs: durationMs,
      dependencyLatencyMs: this.metrics.dependencyLatencyMs,
      reconnectAttempts: mRetries,
      redisRttMs: redisState.latencyMs,
      mongoRttMs: mongoState.latencyMs,
      status: systemStatus,
      failures,
      degradedFrequency: systemStatus === SystemStatus.DEGRADED ? 1 : 0,
      failureFrequency: systemStatus === SystemStatus.FAILED ? 1 : 0,
      integritySignature: snapshotSignature,
    });

    this.checkAngelOneCredentials();
    this.printReport();
    await this.generateAuditReport();

    // If critical systems fail, lock down
    if (systemStatus === SystemStatus.FAILED) {
      await StartupDiagnostics.emitEvent("CHECK_FAILED", "system", { failures });
      throw new Error(`CRITICAL: Institutional startup diagnostics failed! Critical subsystems: ${failures.join(" | ")}`);
    } else {
      await StartupDiagnostics.emitEvent("CHECK_COMPLETED", "system", { systemStatus, durationMs });
    }
  }

  public static printReport(): void {
    const snapshot = this.finalSnapshot;
    if (!snapshot) {
      log.error("[STARTUP] Print report failed: no diagnostics snapshot found.");
      return;
    }

    const c = snapshot.components;
    const boxWidth = 72;
    const border = "=".repeat(boxWidth);
    const line = (label: string, value: string) => {
      const spaceCount = boxWidth - 4 - label.length - value.length;
      const spaces = " ".repeat(Math.max(0, spaceCount));
      return `* ${label}:${spaces}${value} *`;
    };

    console.log("\n" + border);
    console.log(line("INSTITUTIONAL STARTUP HEALTH REPORT", ""));
    console.log(border);
    console.log(line("STARTUP CORRELATION ID", StartupDiagnostics.correlationId));
    console.log(line("STARTUP STATE", snapshot.systemStatus));
    console.log(line("SAFE BOOT MODE ACTIVE", StartupDiagnostics.safeBootModeActive ? "YES" : "NO"));
    console.log(line("INTEGRITY SIGNATURE", snapshot.integritySignature ? snapshot.integritySignature.substring(0, 16) + "..." : "NONE"));
    console.log(line("ACTIVE ENVIRONMENT", config.nodeEnv));
    console.log(line("TIMEZONE STATUS", c.timezone.status));
    console.log(line("DISK WRITABILITY", c.disk.status === ComponentStatus.HEALTHY ? "VERIFIED" : "FAILED"));
    console.log(line("MONGODB INFRASTRUCTURE", c.mongo.status === ComponentStatus.HEALTHY ? "CONNECTED" : "FAILED"));
    console.log(line("MONGODB RTT LATENCY", c.mongo.latencyMs >= 0 ? `${c.mongo.latencyMs} ms` : "N/A"));
    console.log(line("REDIS INFRASTRUCTURE", c.redis.status === ComponentStatus.HEALTHY ? "REACHABLE" : "UNREACHABLE"));
    console.log(line("REDIS VERSION DETECTED", snapshot.redisVersion));
    console.log(line("REDIS RTT LATENCY", c.redis.latencyMs >= 0 ? `${c.redis.latencyMs} ms` : "N/A"));
    console.log(line("BULLMQ COMPATIBILITY", snapshot.isBullMqCompatible ? "FULLY COMPATIBLE" : "DEGRADED COMPATIBILITY FALLBACK ACTIVE"));
    console.log(line("STARTUP BOOT DURATION", `${snapshot.durationMs} ms`));
    console.log(line("TOTAL MONGO RETRIES", `${c.mongo.retryCount}`));
    console.log(border + "\n");
  }

  public static async generateAuditReport(): Promise<void> {
    const snapshot = this.finalSnapshot;
    if (!snapshot) return;

    const c = snapshot.components;
    const filePath = path.join(process.cwd(), "artifacts", "startup_infra_audit.md");
    
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const drift = StartupDiagnostics.calculateDriftAnalytics();
    const heatmap = StartupDiagnostics.generateHeatmaps();

    const markdown = `# Institutional-Grade Infrastructure Hardening & Startup Diagnostics Audit
**Startup Correlation ID:** \`${StartupDiagnostics.correlationId}\`  
**Audit Execution Time:** \`${new Date(snapshot.startedAt).toISOString()}\`  
**System Current State:** \`${snapshot.systemStatus}\`  
**Safe Boot Mode Active:** \`${StartupDiagnostics.safeBootModeActive ? "YES" : "NO"}\`  
**Integrity Signature (SHA256):** \`${snapshot.integritySignature || "N/A"}\`

---

## 1. Startup Volatility & Drift Analytics
* **Startup Volatility (Latency Jitter StdDev):** \`${drift.startupVolatility} ms\`
* **Average MongoDB RTT:** \`${drift.avgMongoRtt} ms\`
* **Average Redis RTT:** \`${drift.avgRedisRtt} ms\`
* **Warmup Phase Duration:** \`${drift.dependencyWarmupDuration} ms\`

---

## 2. Infrastructure Health & Metrics Heatmap
* **Most Unstable Dependency:** \`${heatmap.mostUnstableDependency.toUpperCase()}\`
* **Average Reconnect Attempts:** \`${heatmap.avgRetryCounts} attempts\`
* **Degraded Subsystem Frequencies:**
${Object.entries(heatmap.degradedSubsystemFrequency).map(([k, v]) => `  - **${k.toUpperCase()}:** \`${v} times\``).join("\n") || "  - No degraded subsystems detected."}

---

## 3. Detailed Component Diagnostics Registry

| Subsystem | Status | Latency / Metric | Sequencing Order | Error Details |
| :--- | :--- | :--- | :--- | :--- |
| **System Timezone** | \`${c.timezone.status}\` | Timezone: \`${Intl.DateTimeFormat().resolvedOptions().timeZone}\` | \`${c.timezone.sequencingOrder}\` | \`${c.timezone.errorTraces.join("; ") || "None"}\` |
| **Disk Writability** | \`${c.disk.status === ComponentStatus.HEALTHY ? "VERIFIED" : "FAILED"}\` | Latency: \`${c.disk.latencyMs}ms\` | \`${c.disk.sequencingOrder}\` | \`${c.disk.errorTraces.join("; ") || "None"}\` |
| **Redis Server** | \`${c.redis.status === ComponentStatus.HEALTHY ? "REACHABLE" : "UNREACHABLE"}\` | Redis RTT: \`${c.redis.latencyMs}ms\` | \`${c.redis.sequencingOrder}\` | \`${c.redis.errorTraces.join("; ") || "None"}\` |
| **BullMQ Engine** | \`${c.bullmq.status}\` | Redis Version: \`${snapshot.redisVersion}\` | \`${c.bullmq.sequencingOrder}\` | \`${c.bullmq.errorTraces.join("; ") || "None"}\` |
| **MongoDB Connection** | \`${c.mongo.status === ComponentStatus.HEALTHY ? "CONNECTED" : "FAILED"}\` | Mongo RTT: \`${c.mongo.latencyMs}ms\` | \`${c.mongo.sequencingOrder}\` | \`${c.mongo.errorTraces.join("; ") || "None"} (Attempts: ${c.mongo.retryCount})\` |
| **WebSocket Server** | \`${c.websocket.status === ComponentStatus.HEALTHY ? "READY" : "FAILED"}\` | Verified | \`${c.websocket.sequencingOrder}\` | \`${c.websocket.errorTraces.join("; ") || "None"}\` |
| **Order Management** | \`${c.oms.status === ComponentStatus.HEALTHY ? "OPERATIONAL" : c.oms.status}\` | Verified | \`${c.oms.sequencingOrder}\` | \`${c.oms.errorTraces.join("; ") || "None"}\` |

---

## 4. Hardened Startup Workflow & Graceful Failures
1. **Infra Verification Blocks:** If critical resources (Mongo/Disk/Keys) fail, the app aborts early, emitting diagnostics and exiting with status code \`1\`.
2. **Graceful Pipeline Stoppage:** Pre-empts partial boot crashes by isolating express execution and WS startup until infra check confirmation is attained.
3. **Audit History Logged:** Every boot produces a clean markdown artifact in the \`artifacts/\` space for instant SRE inspection.
`;

    fs.writeFileSync(filePath, markdown, "utf8");
    log.info(`[STARTUP] Audit report compiled and written to: ${filePath}`);
  }
}

/**
 * Boot Sequence Replay Engine: Chronologically reconstructs startup phases.
 */
export class BootSequenceReplayEngine {
  public static async replayFromStream(correlationId: string): Promise<Record<string, any>> {
    log.info(`[REPLAY_ENGINE] Reconstructing boot phase for Correlation ID: ${correlationId}...`);
    
    let bootEvents: InfrastructureTelemetryEvent[] = [];

    // 1. Attempt to load from Redis Telemetry Stream
    try {
      if (redisConnection && redisConnection.status === "ready") {
        const rawEvents = await redisConnection.xrange("infra:startup:audit", "-", "+");
        bootEvents = rawEvents
          .map(([id, fields]) => {
            const obj: Record<string, any> = {};
            for (let i = 0; i < fields.length; i += 2) {
              obj[fields[i]] = fields[i + 1];
            }
            try {
              obj.metadata = JSON.parse(obj.metadata);
            } catch {}
            return obj as InfrastructureTelemetryEvent;
          })
          .filter((e) => e.correlationId === correlationId);
      }
    } catch (e: any) {
      log.warn(`[REPLAY_ENGINE] Failed to read from Redis Stream: ${e.message}. Falling back to in-memory event buffers.`);
    }

    // 2. Fall back to in-memory array if stream read is empty or failed
    if (bootEvents.length === 0) {
      bootEvents = StartupDiagnostics.events.filter((e) => e.correlationId === correlationId);
    }

    if (bootEvents.length === 0) {
      return {
        success: false,
        message: `No telemetry trace found for Correlation ID: ${correlationId}`,
      };
    }

    // Sort chronologically
    bootEvents.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

    const chronologicalLog: string[] = [];
    const subsystemStates: Record<string, string> = {};
    let status = "INCOMPLETE";
    let startedAt = 0;
    let endedAt = 0;

    bootEvents.forEach((evt) => {
      const timeStr = new Date(Number(evt.timestamp)).toISOString();
      if (evt.eventType === "CHECK_STARTED") {
        subsystemStates[evt.subsystem] = "BOOTING";
        chronologicalLog.push(`[${timeStr}] 🟢 Subsystem [${evt.subsystem.toUpperCase()}] diagnostics started (Sequencing: ${evt.metadata.order})`);
        if (!startedAt) startedAt = Number(evt.timestamp);
      } else if (evt.eventType === "CHECK_COMPLETED") {
        subsystemStates[evt.subsystem] = "HEALTHY";
        chronologicalLog.push(`[${timeStr}] ✅ Subsystem [${evt.subsystem.toUpperCase()}] verified HEALTHY. RTT/Metrics: ${JSON.stringify(evt.metadata)}`);
      } else if (evt.eventType === "CHECK_DEGRADED") {
        subsystemStates[evt.subsystem] = "DEGRADED";
        chronologicalLog.push(`[${timeStr}] ⚠️ Subsystem [${evt.subsystem.toUpperCase()}] reported DEGRADED status! Details: ${JSON.stringify(evt.metadata)}`);
      } else if (evt.eventType === "CHECK_FAILED") {
        subsystemStates[evt.subsystem] = "FAILED";
        chronologicalLog.push(`[${timeStr}] 🚨 Subsystem [${evt.subsystem.toUpperCase()}] CHECK FAILED! Trace: ${JSON.stringify(evt.metadata)}`);
      } else if (evt.eventType === "INVARIANT_VIOLATION") {
        chronologicalLog.push(`[${timeStr}] ⛔ SYSTEM INVARIANT VIOLATION! ${evt.metadata.error}`);
      } else if (evt.eventType === "SHUTDOWN_TRIGGERED") {
        status = "FAILED";
        chronologicalLog.push(`[${timeStr}] 🛑 EMERGENCY CIRCUIT BREAKER TRIGGERED SHUTDOWN! Reason: ${evt.metadata.reason}`);
      }
      
      endedAt = Number(evt.timestamp);
    });

    if (subsystemStates["system"] === "HEALTHY" || subsystemStates["oms"] === "HEALTHY") {
      status = "SUCCESSFUL";
    }

    return {
      success: true,
      correlationId,
      status,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: endedAt - startedAt,
      subsystemFinalStates: subsystemStates,
      eventsReplayedCount: bootEvents.length,
      chronologicalLog,
    };
  }
}
