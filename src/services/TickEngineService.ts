// src/services/TickEngineService.ts
import { WebSocket } from "ws";
import Redis from "ioredis";
import AngelTokensModel from "../models/AngelTokens";
import User from "../models/User";
import { config } from "../config";
import { decrypt } from "../utils/encryption";
import { recoverSessionByRefreshOrLogin } from "./AngelSessionLifecycleService";
import { redisBullConnection } from "../utils/redis";
import log from "../utils/logger";
import { clockDriftMonitor } from "./ClockDriftMonitor";
import { isPlausibleLtp } from "../utils/price";
import { ensureValidSession } from "./AngelSessionManager";

interface PendingSubscription {
  exchange: string;
  token: string;
}

export interface TickMetrics {
  ticksProcessed: number;
  ticksPerSec: number;
  parseLatencySumMs: number;
  publishLatencySumMs: number;
  reconnectCount: number;
  malformedPackets: number;
  staleTickRejects: number;
  duplicateTickRejects: number;
  circuitBreakerTrips: number;
  activeSubscriptionsCount: number;
}

export class TickEngineService {
  private static instance: TickEngineService;
  private ws: WebSocket | null = null;
  private pubRedis: Redis;
  private startupCorrelationId: string = "unknown";

  public setStartupCorrelationId(id: string) {
    this.startupCorrelationId = id;
    log.info(`[TickEngine] Configured Startup Correlation ID: ${id}`);
  }
  
  // 1. Subscription Reference Counting ( exchange:token -> refCount )
  private activeSubscriptions = new Map<string, number>(); 
  
  // 2. Tick Sequencing and Dedup Maps ( token -> lastReceivedData )
  private lastSequenceByToken = new Map<string, bigint>();
  private lastTimestampByToken = new Map<string, number>();

  private pendingSubs: PendingSubscription[] = [];
  private pendingUnsubs: PendingSubscription[] = [];
  private batchTimeout: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private isStarted = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = Math.max(10, Number(process.env.TICK_WS_MAX_RETRIES || "30"));
  private reconnectTimer: NodeJS.Timeout | null = null;
  private cooldownTimer: NodeJS.Timeout | null = null;
  private connectGeneration = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastMessageTime = 0;
  private currentStreamUrl = "";
  private streamUrlCandidates: string[] = [];

  // 3. Processing Metrics & Diagnostic Counters
  private metrics: TickMetrics = {
    ticksProcessed: 0,
    ticksPerSec: 0,
    parseLatencySumMs: 0,
    publishLatencySumMs: 0,
    reconnectCount: 0,
    malformedPackets: 0,
    staleTickRejects: 0,
    duplicateTickRejects: 0,
    circuitBreakerTrips: 0,
    activeSubscriptionsCount: 0,
  };

  private tickCounterThisSec = 0;
  private throughputTimer: NodeJS.Timeout | null = null;

  // 4. Parser Circuit Breaker Controls
  private parserFailuresThisMinute = 0;
  private parserResetTimer: NodeJS.Timeout | null = null;
  private isDegraded = false;
  private readonly CB_FAILURE_THRESHOLD = 50; // Reconnect if > 50 malformed packets in 60s

  private constructor() {
    this.pubRedis = new Redis(redisBullConnection as any);
    this.pubRedis.on("error", (err) => log.error("[TickEngine] Redis Pub Error:", err));
    
    // Start throughput metrics ticker
    this.throughputTimer = setInterval(() => {
      this.metrics.ticksPerSec = this.tickCounterThisSec;
      this.tickCounterThisSec = 0;
    }, 1000);

    // Periodically reset parser circuit breaker counter
    this.parserResetTimer = setInterval(() => {
      this.parserFailuresThisMinute = 0;
    }, 60000);
  }

  public static getInstance(): TickEngineService {
    if (!TickEngineService.instance) {
      TickEngineService.instance = new TickEngineService();
    }
    return TickEngineService.instance;
  }

  getMetrics(): TickMetrics {
    this.metrics.activeSubscriptionsCount = this.activeSubscriptions.size;
    return { ...this.metrics };
  }

  async updateSessionCredentials(newJwt: string) {
    log.info(`[TickEngine] Updating active streaming session credentials atomically...`);
    this.cleanupSocket("SESSION_ROTATION");
    await this.start();
  }

  async start() {
    this.isStarted = true;
    if (this.cooldownTimer) return;
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) return;

    this.isConnecting = true;
    this.isDegraded = false;
    this.connectGeneration += 1;
    const generation = this.connectGeneration;
    log.info("[TickEngine] Starting Single-Instance Binary Streaming Connection...");

    try {
      const session = await this.getSystemSession();
      this.streamUrlCandidates = this.getSmartStreamUrlCandidates();
      this.currentStreamUrl = this.selectStreamUrlForAttempt(this.reconnectAttempts);

      log.info("[TickEngine] Opening market stream socket", {
        generation,
        attempt: this.reconnectAttempts + 1,
        endpoint: this.currentStreamUrl,
        clientCode: session.clientCode,
        hasJwt: Boolean(session.jwtToken),
        hasFeedToken: Boolean(session.feedToken),
        hasApiKey: Boolean(session.apiKey),
      });

      this.cleanupSocket("RECONNECT_CLEANUP");

      this.ws = new WebSocket(this.currentStreamUrl, {
        headers: {
          Authorization: `Bearer ${session.jwtToken}`,
          "x-client-code": session.clientCode,
          "x-feed-token": session.feedToken,
          "x-api-key": session.apiKey,
        },
      });

      this.ws.on("open", () => {
        if (generation !== this.connectGeneration) return;
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.lastMessageTime = Date.now();
        log.info("[TickEngine] Connected to AngelOne SmartAPI Stream gateway successfully.", {
          endpoint: this.currentStreamUrl,
          activeSubscriptions: this.activeSubscriptions.size,
        });
        this.resubscribeActiveTokens();
        this.startHeartbeatMonitor();
        this.startPingMonitor();
      });

      this.ws.on("message", (data: any) => {
        if (generation !== this.connectGeneration) return;
        this.lastMessageTime = Date.now();
        if (typeof data === "string") {
          const msg = data.toLowerCase();
          if (msg === "pong" || msg === "ping") return;
        } else if (Buffer.isBuffer(data)) {
          this.handleBinaryTickSafe(data);
        }
      });

      this.ws.on("pong", () => {
        if (generation !== this.connectGeneration) return;
        this.lastMessageTime = Date.now();
      });

      this.ws.on("close", (code, reason) => {
        if (generation !== this.connectGeneration) return;
        this.isConnecting = false;
        const reasonText = Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "");
        log.warn(`[TickEngine] Connection closed. Code: ${code}, Reason: ${reasonText}`);
        this.stopHeartbeatMonitor();
        this.stopPingMonitor();
        this.ws = null;
        this.scheduleReconnect();
      });

      this.ws.on("error", (err) => {
        if (generation !== this.connectGeneration) return;
        const msg = String(err?.message || "UNKNOWN_WS_ERROR");
        log.error("[TickEngine] WebSocket Error:", {
          message: msg,
          endpoint: this.currentStreamUrl,
          attempt: this.reconnectAttempts + 1,
        });
        if (msg.includes("ENOTFOUND")) {
          this.rotateEndpointCandidate();
        }
      });

    } catch (err: any) {
      this.isConnecting = false;
      log.error("[TickEngine] Startup failed:", err.message);
      this.scheduleReconnect();
    }
  }

  // 🛡️ Reference Counted Subscription Strategy
  subscribe(exchange: string, token: string) {
    const key = `${exchange}:${token}`.toUpperCase().trim();
    const currentCount = this.activeSubscriptions.get(key) || 0;

    this.activeSubscriptions.set(key, currentCount + 1);

    // Only subscribe to exchange feed if this is the first reference (0 -> 1)
    if (currentCount === 0) {
      this.pendingSubs.push({ exchange, token });
      this.triggerBatchUpdate();
    }
  }

  // 🛡️ Reference Counted Unsubscribe Strategy
  unsubscribe(exchange: string, token: string) {
    const key = `${exchange}:${token}`.toUpperCase().trim();
    const currentCount = this.activeSubscriptions.get(key) || 0;

    if (currentCount <= 0) return;

    if (currentCount === 1) {
      this.activeSubscriptions.delete(key);
      // Clean up local tracking maps to prevent memory leaks
      this.lastSequenceByToken.delete(token);
      this.lastTimestampByToken.delete(token);

      this.pendingUnsubs.push({ exchange, token });
      this.triggerBatchUpdate();
    } else {
      this.activeSubscriptions.set(key, currentCount - 1);
    }
  }

  private triggerBatchUpdate() {
    if (this.batchTimeout) return;

    this.batchTimeout = setTimeout(() => {
      this.batchTimeout = null;
      this.flushPendingOperations();
    }, 150); // Debounce interval of 150ms
  }

  private flushPendingOperations() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (this.pendingSubs.length > 0) {
      this.sendSubscriptionPayload(this.pendingSubs, 1); // Action 1 = Subscribe
      this.pendingSubs = [];
    }

    if (this.pendingUnsubs.length > 0) {
      this.sendSubscriptionPayload(this.pendingUnsubs, 2); // Action 2 = Unsubscribe
      this.pendingUnsubs = [];
    }
  }

  private sendSubscriptionPayload(items: PendingSubscription[], action: number) {
    const exchangeGroups: Record<number, string[]> = {};

    items.forEach((item) => {
      const exType = this.getExchangeTypeInt(item.exchange, item.token);
      if (!exchangeGroups[exType]) exchangeGroups[exType] = [];
      exchangeGroups[exType].push(item.token);
    });

    const tokenList = Object.entries(exchangeGroups).map(([type, tokens]) => ({
      exchangeType: Number(type),
      tokens,
    }));

    const payload = {
      action,
      params: {
        mode: 1, // Mode 1 = LTP (Low latency price packets)
        tokenList,
      },
    };

    try {
      this.ws?.send(JSON.stringify(payload));
      log.info(`[TickEngine] Sent subscription frame. Action: ${action === 1 ? 'SUBSCRIBE' : 'UNSUBSCRIBE'}, Groups: ${tokenList.length}`);
    } catch (err: any) {
      log.error("[TickEngine] Failed to send subscription frame:", err.message);
    }
  }

  private resubscribeActiveTokens() {
    if (this.activeSubscriptions.size === 0) return;

    log.info(`[TickEngine] Restoring subscriptions for ${this.activeSubscriptions.size} active reference-tracked tokens.`);
    const items: PendingSubscription[] = Array.from(this.activeSubscriptions.keys()).map((key) => {
      const [exchange, token] = key.split(":");
      return { exchange, token };
    });

    this.sendSubscriptionPayload(items, 1);
  }

  // 🛡️ CRASH-SAFE PARSER & SEQUENCE VALIDATION PIPELINE
  private handleBinaryTickSafe(buffer: Buffer) {
    const startTime = Date.now();

    try {
      // 1. Packet Bounds Validation
      // SmartAPI binary LTP packet layout:
      // mode(1), exchangeType(1), token(25), sequence(8), exchangeTimestamp(8), ltp(8).
      if (buffer.length < 51) {
        this.registerMalformedPacket("INSUFFICIENT_PACKET_LENGTH");
        return;
      }

      const subscriptionMode = buffer.readUInt8(0);
      const exchangeType = buffer.readUInt8(1);
      
      // Bounds-safe token slice extraction
      const token = buffer.toString("ascii", 2, 27).replace(/\0/g, "").trim();
      if (!token) {
        this.registerMalformedPacket("EMPTY_TOKEN_FIELD");
        return;
      }

      // Read 64-bit sequence identifier atomically
      const sequence = buffer.readBigInt64LE(27);
      
      const exchangeTimestamp = Number(buffer.readBigInt64LE(35));
      const exchangeName = this.getExchangeNameStr(exchangeType);

      // SmartAPI sends prices in paise as an int64 at byte offset 43.
      // Reading byte 35 reads timestamp bytes as price and creates huge fake premiums.
      const rawLtp = Number(buffer.readBigInt64LE(43));
      const ltp = rawLtp / 100;

      if (!isPlausibleLtp(exchangeName, ltp)) {
        this.registerMalformedPacket("IMPLAUSIBLE_LTP");
        log.warn("[TickEngine] Rejected implausible LTP packet", {
          exchange: exchangeName,
          token,
          rawLtp,
          ltp,
          exchangeTimestamp,
          packetLength: buffer.length,
        });
        return;
      }

      // 2. Out-of-Order & Replay Sequence Validation
      const lastSeq = this.lastSequenceByToken.get(token);
      if (lastSeq !== undefined && sequence <= lastSeq) {
        this.metrics.duplicateTickRejects += 1;
        return; // Reject replayed or out-of-order broker packet
      }
      this.lastSequenceByToken.set(token, sequence);

      // 3. Clock Drift and Stale Tick Validation
      const localTime = Date.now();
      const isValid = clockDriftMonitor.validateTickTimestamp(localTime);
      if (!isValid) {
        this.metrics.staleTickRejects += 1;
        return;
      }

      const parseLatency = Date.now() - startTime;
      this.metrics.parseLatencySumMs += parseLatency;

      const channel = `ticks:${exchangeName}:${token}`.toUpperCase();

      const tickPayload = JSON.stringify({
        exchange: exchangeName,
        token,
        ltp,
        timestamp: localTime,
        sequence: sequence.toString(),
      });

      // 🚀 MULTICAST EVENT TO REDIS PUB/SUB & REDUCE CACHE TTL TO 1.5 SECONDS
      const publishStart = Date.now();
      this.pubRedis.publish(channel, tickPayload);
      
      // Reduce cached TTL from 5s to 1.5s to prevent stale data hydration on recovery
      this.pubRedis.setex(`LTP:${exchangeName}:${token}`, 2, ltp.toString()); // setex requires integer, 2s is safest near-1.5s bound

      const publishLatency = Date.now() - publishStart;
      this.metrics.publishLatencySumMs += publishLatency;

      this.metrics.ticksProcessed += 1;
      this.tickCounterThisSec += 1;

    } catch (err: any) {
      this.registerMalformedPacket("PARSING_EXCEPTION");
      log.error("[TickEngine] Critical parse error isolated:", err.message);
    }
  }

  private registerMalformedPacket(reason: string) {
    this.metrics.malformedPackets += 1;
    this.parserFailuresThisMinute += 1;

    if (this.parserFailuresThisMinute >= this.CB_FAILURE_THRESHOLD && !this.isDegraded) {
      this.triggerCircuitBreaker(reason);
    }
  }

  private triggerCircuitBreaker(reason: string) {
    this.isDegraded = true;
    this.metrics.circuitBreakerTrips += 1;
    log.error(`[TickEngine] CIRCUIT BREAKER TRIPPED! Reason: ${reason}. Entering DEGRADED mode.`);
    
    // Terminate WS connection to trigger immediate cleanup & self-healing reconnect
    this.ws?.terminate();
  }

  private getExchangeTypeInt(exchange: string, token: string): number {
    const ex = String(exchange).toUpperCase().trim();
    if (ex === "NSE") {
      return token.length > 5 ? 2 : 1;
    }
    if (ex === "NFO" || ex === "NSE_FO") return 2;
    if (ex === "BSE") return 3;
    if (ex === "BFO" || ex === "BSE_FO") return 4;
    if (ex === "MCX" || ex === "MCX_FO") return 5;
    return 1;
  }

  private getExchangeNameStr(type: number): string {
    switch (type) {
      case 1: return "NSE";
      case 2: return "NFO";
      case 3: return "BSE";
      case 4: return "BFO";
      case 5: return "MCX";
      default: return "NSE";
    }
  }

  private scheduleReconnect() {
    if (!this.isStarted) return;
    if (this.reconnectTimer || this.cooldownTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      const cooldownMs = Math.max(60_000, Number(process.env.TICK_WS_COOLDOWN_MS || "300000"));
      log.error("[TickEngine] Maximum reconnect attempts reached. Entering cooldown.", {
        cooldownMs,
        attempts: this.reconnectAttempts,
      });
      this.cooldownTimer = setTimeout(() => {
        this.cooldownTimer = null;
        this.reconnectAttempts = 0;
        this.start().catch((err) => log.error("[TickEngine] Restart after cooldown failed", err));
      }, cooldownMs);
      return;
    }

    this.reconnectAttempts += 1;
    this.metrics.reconnectCount += 1;
    const base = Math.min(Math.pow(2, this.reconnectAttempts) * 1000, 30000);
    const jitter = Math.floor(Math.random() * 1000);
    const delay = base + jitter;
    log.warn(`[TickEngine] Scheduling reconnect in ${delay}ms (Attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((err) => {
        log.error("[TickEngine] Reconnect start failed", err);
      });
    }, delay);
  }

  // 🛡️ ADAPTIVE HEARTBEAT BASED ON MARKET HOURS
  private startHeartbeatMonitor() {
    this.stopHeartbeatMonitor();
    
    const timeoutMs = this.getHeartbeatTimeoutMs();
    log.info(`[TickEngine] Heartbeat monitor initialized with adaptive threshold: ${timeoutMs}ms`);

    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const currentTimeout = this.getHeartbeatTimeoutMs();
      
      if (now - this.lastMessageTime > currentTimeout) {
        log.warn(`[TickEngine] Heartbeat timeout! No price packets received for ${currentTimeout}ms. Reconnecting...`);
        this.ws?.terminate();
      }
    }, 4000);
  }

  private getHeartbeatTimeoutMs(): number {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();
    const minute = now.getMinutes();

    const isWeekend = day === 0 || day === 6;
    const isMarketHours = !isWeekend && (hour > 9 || (hour === 9 && minute >= 15)) && (hour < 15 || (hour === 15 && minute <= 30));

    if (isMarketHours) {
      return 6000; // Aggressive 6-second heartbeat during high-volume market hours
    }
    return 30000; // Relaxed 30-second heartbeat during inactive off-market hours
  }

  private stopHeartbeatMonitor() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startPingMonitor() {
    this.stopPingMonitor();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.ping();
        this.ws.send("ping");
      } catch (err: any) {
        log.warn("[TickEngine] ping send failed", { message: err?.message });
      }
    }, 10_000);
  }

  private stopPingMonitor() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private cleanupSocket(reason: string) {
    if (!this.ws) return;
    try {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.terminate();
      }
    } catch (err: any) {
      log.warn("[TickEngine] cleanupSocket warning", { reason, message: err?.message });
    } finally {
      this.ws = null;
      this.stopHeartbeatMonitor();
      this.stopPingMonitor();
    }
  }

  private getSmartStreamUrlCandidates(): string[] {
    const candidates = [
      String(config.angelSmartStreamUrl || "").trim(),
      "wss://smartapisocket.angelone.in/smart-stream",
      "wss://smartapisecure.angelone.in/smart-stream",
    ].filter(Boolean);

    return Array.from(new Set(candidates));
  }

  private selectStreamUrlForAttempt(attempt: number): string {
    if (!this.streamUrlCandidates.length) {
      this.streamUrlCandidates = this.getSmartStreamUrlCandidates();
    }
    const idx = Math.min(attempt, this.streamUrlCandidates.length - 1);
    return this.streamUrlCandidates[idx];
  }

  private rotateEndpointCandidate() {
    if (this.streamUrlCandidates.length <= 1) return;
    const [head, ...rest] = this.streamUrlCandidates;
    this.streamUrlCandidates = [...rest, head];
    log.warn("[TickEngine] Rotated websocket endpoint candidate after DNS/network error", {
      nextEndpoint: this.streamUrlCandidates[0],
    });
  }

  private async getSystemSession() {
    const clientCode = config.dataClientCode || "";
    if (!clientCode) {
      throw new Error("System DATA_CLIENT_CODE is not configured");
    }

    let tokenDoc: any = await AngelTokensModel.findOne({ clientcode: clientCode }).lean();

    if (!tokenDoc) {
      const allUsers = await User.find({}).select("+client_key +broker_password +broker_totp_secret +api_key").lean() as any[];
      const matchingUser = allUsers.find((u) => {
        const decryptedKey = u.client_key ? decrypt(u.client_key) : "";
        return decryptedKey === clientCode || u.clientcode === clientCode;
      });

      if (matchingUser) {
        log.info(`[TickEngine] Creating new AngelTokens record for system user ${matchingUser._id}`);
        tokenDoc = await AngelTokensModel.create({
          userId: matchingUser._id,
          clientcode: clientCode,
          apiKey: matchingUser.api_key,
        });
        tokenDoc = (tokenDoc as any).toObject();
      } else {
        throw new Error(`System client code ${clientCode} user profile not found in database.`);
      }
    }

    const context = "tick_engine_auth";
    try {
      const validSession = await ensureValidSession({
        userId: tokenDoc?.userId ? String(tokenDoc.userId) : undefined,
        clientcode: clientCode,
        purpose: context,
      });

      return {
        jwtToken: validSession.jwtToken,
        feedToken: validSession.feedToken,
        apiKey: validSession.apiKey,
        clientCode,
      };
    } catch (err: any) {
      log.warn("[TickEngine] ensureValidSession failed, falling back to legacy recovery path", {
        clientCode,
        message: err?.message,
      });
    }

    const decryptedJwt = tokenDoc!.jwtToken ? decrypt(tokenDoc!.jwtToken) : "";
    const decryptedFeed = tokenDoc!.feedToken ? decrypt(tokenDoc!.feedToken) : "";
    const decryptedApiKey = tokenDoc!.apiKey ? decrypt(tokenDoc!.apiKey) : "";

    if (!decryptedJwt || !decryptedFeed || !decryptedApiKey) {
      log.info(`[TickEngine] Tokens missing in session for ${clientCode}. Triggering recovery.`);
      const recovery = await recoverSessionByRefreshOrLogin(tokenDoc, context);
      if (!recovery.ok || !recovery.jwtToken || !recovery.feedToken) {
        throw new Error(`Failed to recover system session: ${recovery.reason}`);
      }
      return {
        jwtToken: recovery.jwtToken,
        feedToken: recovery.feedToken,
        apiKey: decryptedApiKey || (tokenDoc!.apiKey ? decrypt(tokenDoc!.apiKey) : ""),
        clientCode,
      };
    }

    return {
      jwtToken: decryptedJwt,
      feedToken: decryptedFeed,
      apiKey: decryptedApiKey,
      clientCode,
    };
  }
}

export const tickEngineService = TickEngineService.getInstance();
