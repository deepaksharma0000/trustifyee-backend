// src/services/SessionAuthority.ts
import { tickEngineService } from "./TickEngineService";
import { findAngelTokensForUserClient } from "./AngelSessionContextService";
import { recoverSessionByRefreshOrLogin } from "./AngelSessionLifecycleService";
import log from "../utils/logger";

export type SessionState =
  | "SESSION_ACTIVE"
  | "SESSION_ROTATING"
  | "SESSION_OVERLAP"
  | "SESSION_RETIRED"
  | "SESSION_RECOVERING"
  | "SESSION_INVALID";

export interface SessionMetrics {
  sessionOverlapDurationMs: number;
  tokenRotationLatencyMs: number;
  websocketHandoffGapsCount: number;
  staleSessionSuppressionsCount: number;
  splitBrainPreventionsCount: number;
}

export interface SessionRecord {
  userId: string;
  clientCode: string;
  state: SessionState;
  activeJwt: string;
  overlappingJwt?: string;
  overlapStartedAt?: number;
  updatedAt: number;
}

export class SessionAuthority {
  private static instance: SessionAuthority;
  private startupCorrelationId: string = "unknown";

  public setStartupCorrelationId(id: string) {
    this.startupCorrelationId = id;
    log.info(`[SessionAuthority] Configured Startup Correlation ID: ${id}`);
  }

  private sessions = new Map<string, SessionRecord>(); // userId|clientCode -> SessionRecord

  private sessionKey(userId: string, clientCode: string) {
    return `${userId}|${clientCode}`;
  }
  
  // Staggering parameters
  private readonly REFRESH_JITTER_RANGE_MS = 600000; // 10 minutes jitter range

  private metrics: SessionMetrics = {
    sessionOverlapDurationMs: 0,
    tokenRotationLatencyMs: 0,
    websocketHandoffGapsCount: 0,
    staleSessionSuppressionsCount: 0,
    splitBrainPreventionsCount: 0,
  };

  private constructor() {}

  public static getInstance(): SessionAuthority {
    if (!SessionAuthority.instance) {
      SessionAuthority.instance = new SessionAuthority();
    }
    return SessionAuthority.instance;
  }

  public getMetrics(): SessionMetrics {
    return { ...this.metrics };
  }

  /**
   * Safe Session Rotation starting point.
   * Enforces transition to SESSION_ROTATING, and implements staggering to prevent login storm.
   */
  public async rotateSession(userId: string, clientCode: string): Promise<boolean> {
    const key = this.sessionKey(userId, clientCode);
    const session = this.sessions.get(key);
    if (session && session.state === "SESSION_ROTATING") {
      this.metrics.splitBrainPreventionsCount += 1;
      log.warn(`[SessionAuthority] Rotation already in progress for ${userId}/${clientCode}. Preventing duplicate trigger.`);
      return false;
    }

    log.info(`[SessionAuthority] Initiating staged Dual-Session Rotation for ${userId}/${clientCode}`);
    const rotationStartTime = Date.now();

    // 1. Stagger refresh with randomized jitter to protect TOTP gateway
    const jitter = Math.floor(Math.random() * 5000); // 0 to 5 seconds local delay stagger
    await new Promise((resolve) => setTimeout(resolve, jitter));

    try {
      this.updateState(key, userId, clientCode, "SESSION_ROTATING");

      const tokens = await findAngelTokensForUserClient(userId, clientCode, false);
      if (!tokens?.refreshToken) {
        throw new Error(`Missing refreshToken for ${userId}/${clientCode}. Cannot rotate session.`);
      }

      const recovered = await recoverSessionByRefreshOrLogin(tokens, "session_authority_rotate");
      if (!recovered.ok || !recovered.jwtToken) {
        throw new Error(recovered.reason || "Broker session refresh failed during rotation.");
      }

      const newJwtToken = recovered.jwtToken;

      // 2. Establish SESSION_OVERLAP stage
      const currentSession = this.sessions.get(key);
      const oldJwt = currentSession ? currentSession.activeJwt : "";

      this.sessions.set(key, {
        userId,
        clientCode,
        state: "SESSION_OVERLAP",
        activeJwt: newJwtToken,
        overlappingJwt: oldJwt,
        overlapStartedAt: Date.now(),
        updatedAt: Date.now(),
      });

      this.metrics.tokenRotationLatencyMs = Date.now() - rotationStartTime;
      log.info(`[SessionAuthority] Overlapping Dual-Session established for ${clientCode}. Active JWT rotated, holding old JWT for warm-up phase.`);

      // 3. Trigger atomic web socket session handoff
      await this.handoffWebsocketSession(clientCode, newJwtToken);

      // 4. Staged retirement of old JWT after 10-second warm-up overlap window
      setTimeout(() => {
        this.retireOldSession(key);
      }, 10000);

      return true;

    } catch (err: any) {
      log.error(`[SessionAuthority] Token rotation failed for ${clientCode}:`, err.message);
      this.updateState(key, userId, clientCode, "SESSION_INVALID");
      return false;
    }
  }

  private updateState(key: string, userId: string, clientCode: string, state: SessionState) {
    const existing = this.sessions.get(key);
    if (existing) {
      existing.state = state;
      existing.updatedAt = Date.now();
    } else {
      this.sessions.set(key, {
        userId,
        clientCode,
        state,
        activeJwt: "",
        updatedAt: Date.now(),
      });
    }
  }

  private retireOldSession(key: string) {
    const session = this.sessions.get(key);
    if (session && session.state === "SESSION_OVERLAP") {
      session.state = "SESSION_RETIRED";
      session.overlappingJwt = undefined;
      session.overlapStartedAt = undefined;
      session.updatedAt = Date.now();
      
      this.metrics.sessionOverlapDurationMs = 10000;
      log.info(`[SessionAuthority] Staged retirement complete. Old JWT closed for ${session.clientCode}. State: SESSION_ACTIVE`);
      session.state = "SESSION_ACTIVE";
    }
  }

  /**
   * Replays subscriptions and re-binds WebSocket to the rotated session payload without gaps.
   */
  private async handoffWebsocketSession(clientCode: string, newJwtToken: string) {
    try {
      log.info(`[SessionAuthority] Triggering atomic WebSocket subscription sync to new session payload for ${clientCode}`);
      
      // Update the running TickEngineService stream session
      await tickEngineService.updateSessionCredentials(newJwtToken);
      
    } catch (err: any) {
      this.metrics.websocketHandoffGapsCount += 1;
      log.error(`[SessionAuthority] WebSocket handoff encountered issues for ${clientCode}:`, err.message);
    }
  }

  public getActiveJwt(userId: string, clientCode: string): string | undefined {
    const session = this.sessions.get(this.sessionKey(userId, clientCode));
    if (!session) return undefined;
    
    // Fallback: If inside overlap window, return the newly verified JWT
    return session.activeJwt;
  }
}

export const sessionAuthority = SessionAuthority.getInstance();
