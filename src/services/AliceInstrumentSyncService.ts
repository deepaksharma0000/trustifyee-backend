import { SystemSetting } from "../models/SystemSetting";
import { AliceInstrumentService } from "./aliceInstrumentService";
import { countAliceInstruments } from "../utils/aliceInstrumentResolver";
import { config } from "../config";
import log from "../utils/logger";
import redisConnection from "../utils/redis";

export type AliceInstrumentSyncStatus =
  | "idle"
  | "in_progress"
  | "success"
  | "failed"
  | "skipped";

export type AliceInstrumentSyncState = {
  exchange: string;
  status: AliceInstrumentSyncStatus;
  lastSyncAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  instrumentCount: number;
  inserted?: number;
  skipped?: number;
  durationMs?: number;
  triggeredBy?: "startup" | "manual" | "scheduled";
};

const STATE_KEY = "alice_instrument_sync:NFO";
const LOCK_KEY = "lock:alice-instrument-sync:nfo";
const LOCK_TTL_SEC = 30 * 60;
const MIN_SYNC_INTERVAL_MS = Number(process.env.ALICE_INSTRUMENT_SYNC_MIN_INTERVAL_MS || 6 * 60 * 60 * 1000);

export class AliceInstrumentSyncService {
  private static inProcess = false;
  private static startupScheduled = false;

  static async getState(): Promise<AliceInstrumentSyncState> {
    const stored = await SystemSetting.findOne({ key: STATE_KEY }).lean();
    const count = await countAliceInstruments("NFO");

    if (!stored?.value) {
      return {
        exchange: "NFO",
        status: "idle",
        instrumentCount: count,
      };
    }

    return {
      ...(stored.value as AliceInstrumentSyncState),
      instrumentCount: count,
    };
  }

  static async getHealthSnapshot() {
    const state = await this.getState();
    return {
      exchange: state.exchange,
      syncStatus: state.status,
      lastInstrumentSyncAt: state.lastSyncAt || null,
      lastSuccessAt: state.lastSuccessAt || null,
      totalInstrumentsLoaded: state.instrumentCount,
      lastError: state.lastError || null,
      lastInserted: state.inserted ?? null,
      lastSkipped: state.skipped ?? null,
      lastDurationMs: state.durationMs ?? null,
      startupSyncEnabled: config.aliceStartupSyncNfo,
      inProcess: this.inProcess,
    };
  }

  private static async persistState(partial: Partial<AliceInstrumentSyncState>): Promise<void> {
    const current = await this.getState();
    const next: AliceInstrumentSyncState = {
      ...current,
      ...partial,
      exchange: "NFO",
    };

    await SystemSetting.findOneAndUpdate(
      { key: STATE_KEY },
      {
        key: STATE_KEY,
        value: next,
        description: "Alice Blue NFO contract master sync state",
      },
      { upsert: true, new: true }
    );
  }

  private static async acquireLock(): Promise<boolean> {
    try {
      const result = await redisConnection.set(LOCK_KEY, String(process.pid), "EX", LOCK_TTL_SEC, "NX");
      return result === "OK";
    } catch (err: any) {
      log.warn("[AliceInstrumentSync] Redis lock unavailable — using in-process guard only", {
        message: err?.message,
      });
      return !this.inProcess;
    }
  }

  private static async releaseLock(): Promise<void> {
    try {
      await redisConnection.del(LOCK_KEY);
    } catch {
      // best effort
    }
  }

  private static shouldSkipDueToInterval(lastSyncAt?: string): boolean {
    if (!lastSyncAt) return false;
    const elapsed = Date.now() - new Date(lastSyncAt).getTime();
    return elapsed < MIN_SYNC_INTERVAL_MS;
  }

  /**
   * Fire-and-forget startup sync. Never throws — failures are logged and persisted.
   */
  static scheduleStartupSync(): void {
    if (this.startupScheduled) return;
    if (!config.aliceStartupSyncNfo) {
      log.info("[AliceInstrumentSync] Startup NFO sync disabled (ALICE_STARTUP_SYNC_NFO=false)");
      return;
    }

    this.startupScheduled = true;

    setImmediate(() => {
      this.syncNfo({ triggeredBy: "startup", force: false }).catch((err) => {
        log.error("[AliceInstrumentSync] Startup sync failed (non-fatal)", {
          message: err?.message,
        });
      });
    });
  }

  static async syncNfo(options: {
    triggeredBy: "startup" | "manual" | "scheduled";
    force?: boolean;
  }): Promise<AliceInstrumentSyncState> {
    if (this.inProcess) {
      log.info("[AliceInstrumentSync] Sync already in progress — skipping duplicate job");
      const state = await this.getState();
      return { ...state, status: "skipped" };
    }

    const prior = await this.getState();
    if (!options.force && this.shouldSkipDueToInterval(prior.lastSuccessAt || prior.lastSyncAt)) {
      log.info("[AliceInstrumentSync] Skipping NFO sync — minimum interval not elapsed", {
        lastSyncAt: prior.lastSuccessAt || prior.lastSyncAt,
        minIntervalMs: MIN_SYNC_INTERVAL_MS,
      });
      return { ...prior, status: "skipped" };
    }

    const lockOk = await this.acquireLock();
    if (!lockOk) {
      log.info("[AliceInstrumentSync] Another instance holds sync lock — skipping");
      return { ...(await this.getState()), status: "skipped" };
    }

    this.inProcess = true;
    const startedAt = Date.now();

    await this.persistState({
      status: "in_progress",
      lastSyncAt: new Date().toISOString(),
      triggeredBy: options.triggeredBy,
      lastError: undefined,
    });

    log.info("[AliceInstrumentSync] Starting NFO contract master sync", {
      triggeredBy: options.triggeredBy,
    });

    try {
      const result = await AliceInstrumentService.syncExchangeInstruments({ exchange: "NFO" });
      const instrumentCount = await countAliceInstruments("NFO");
      const durationMs = Date.now() - startedAt;
      const now = new Date().toISOString();

      const state: AliceInstrumentSyncState = {
        exchange: "NFO",
        status: "success",
        lastSyncAt: now,
        lastSuccessAt: now,
        instrumentCount,
        inserted: result.count,
        skipped: result.skipped,
        durationMs,
        triggeredBy: options.triggeredBy,
      };

      await this.persistState(state);

      log.info("[AliceInstrumentSync] NFO sync completed", {
        inserted: result.count,
        skipped: result.skipped,
        instrumentCount,
        durationMs,
      });

      return state;
    } catch (err: any) {
      const message = err?.message || String(err);
      const instrumentCount = await countAliceInstruments("NFO");
      const durationMs = Date.now() - startedAt;

      const state: AliceInstrumentSyncState = {
        exchange: "NFO",
        status: "failed",
        lastSyncAt: new Date().toISOString(),
        lastSuccessAt: prior.lastSuccessAt,
        lastError: message,
        instrumentCount,
        durationMs,
        triggeredBy: options.triggeredBy,
      };

      await this.persistState(state);

      log.error("[AliceInstrumentSync] NFO sync failed (application continues)", {
        message,
        durationMs,
      });

      return state;
    } finally {
      this.inProcess = false;
      await this.releaseLock();
    }
  }
}
