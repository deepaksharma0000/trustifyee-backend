import User from "../models/User";
import { decrypt } from "../utils/encryption";
import { config } from "../config";
import {
  findAliceTokensForClient,
  normalizeAliceClientCode,
  validateAliceSessionForUser,
} from "./AliceSessionService";
import { resolveAliceInstrument } from "../utils/aliceInstrumentResolver";
import log from "../utils/logger";

export type AliceValidationCheck = {
  code: string;
  passed: boolean;
  message: string;
};

export type AliceUserValidationResult = {
  userId: string;
  userName: string | null;
  email: string | null;
  broker: "ALICEBLUE";
  eligible: boolean;
  reason: string;
  checks: AliceValidationCheck[];
};

export type AliceBroadcastValidationReport = {
  signalId?: string;
  tradingsymbol: string;
  exchange: string;
  instrumentResolved: boolean;
  instrumentToken?: string;
  eligible: AliceUserValidationResult[];
  rejected: AliceUserValidationResult[];
  summary: {
    totalAliceUsers: number;
    eligibleCount: number;
    rejectedCount: number;
  };
};

function normalizeBroker(input: unknown): string {
  return String(input || "").trim().toUpperCase();
}

function isAliceUser(user: any): boolean {
  const b = normalizeBroker(user?.broker);
  return b === "ALICEBLUE" || b === "ALICE_BLUE";
}

export class AliceBlueBroadcastValidationService {
  static async validateUser(
    user: any,
    signal: { exchange?: string; tradingsymbol?: string; symboltoken?: string },
    aliceTokenDoc?: any
  ): Promise<AliceUserValidationResult> {
    const userId = String(user?._id || "");
    const checks: AliceValidationCheck[] = [];

    const pass = (code: string, message: string) => {
      checks.push({ code, passed: true, message });
    };
    const fail = (code: string, message: string) => {
      checks.push({ code, passed: false, message });
    };

    if (user?.status !== "active") {
      fail("ACCOUNT_ACTIVE", "User account is not active");
    } else {
      pass("ACCOUNT_ACTIVE", "User account is active");
    }

    if (user?.trading_status !== "enabled") {
      fail("TRADING_ENABLED", "Trading is disabled for this user");
    } else {
      pass("TRADING_ENABLED", "Trading is enabled");
    }

    if (!user?.broker_connected) {
      fail("BROKER_CONNECTED", "Broker is not connected");
    } else {
      pass("BROKER_CONNECTED", "Broker connected flag is set");
    }

    if (normalizeBroker(user?.broker) !== "ALICEBLUE") {
      fail("BROKER_ALICEBLUE", `Broker is ${user?.broker || "unknown"}, not Alice Blue`);
    } else {
      pass("BROKER_ALICEBLUE", "Broker is Alice Blue");
    }

    const rawClientCode = user?.client_key ? decrypt(user.client_key) : "";
    if (!rawClientCode || rawClientCode.trim().length < 3) {
      fail("CLIENT_CODE", "Client code missing or invalid in user profile");
    } else {
      pass("CLIENT_CODE", "Client code present");
    }

    const tokenDoc =
      aliceTokenDoc ||
      (rawClientCode
        ? await findAliceTokensForClient(normalizeAliceClientCode(rawClientCode), userId)
        : null);

    if (!tokenDoc?.sessionId) {
      fail("SESSION", "Alice Blue OAuth session missing — user must reconnect broker");
    } else if (tokenDoc.expiresAt && new Date(tokenDoc.expiresAt).getTime() <= Date.now()) {
      fail("SESSION", "Alice Blue session expired — user must reconnect via OAuth");
    } else {
      pass("SESSION", "Alice Blue session is valid");
    }

    if (rawClientCode && userId) {
      const sessionCheck = await validateAliceSessionForUser(userId, rawClientCode);
      if (!sessionCheck.ok) {
        const existing = checks.find((c) => c.code === "SESSION");
        if (existing) {
          existing.passed = false;
          existing.message = sessionCheck.reason || existing.message;
        } else {
          fail("SESSION", sessionCheck.reason || "Session validation failed");
        }
      }
    }

    if (user?.trading_paused === true) {
      fail("COPY_TRADING", "Trading paused due to consecutive failures (circuit breaker)");
    } else {
      pass("COPY_TRADING", "User eligible for copy trading");
    }

    if (!config.aliceAllowServerExecution) {
      fail("SERVER_EXECUTION", "Alice server-side execution disabled (ALICE_ALLOW_SERVER_EXECUTION=false)");
    } else {
      pass("SERVER_EXECUTION", "Server-side Alice execution enabled");
    }

    const exchange = String(signal?.exchange || "NFO").toUpperCase();
    const tradingsymbol = String(signal?.tradingsymbol || "").trim();
    if (!tradingsymbol) {
      fail("SIGNAL_SYMBOL", "Signal tradingsymbol missing");
    } else {
      const resolution = await resolveAliceInstrument(
        exchange,
        tradingsymbol,
        signal?.symboltoken
      );
      if (!resolution.found) {
        fail(
          "INSTRUMENT_TOKEN",
          `Alice instrument not found for ${exchange} ${tradingsymbol}. Run NFO instrument sync.`
        );
      } else {
        pass(
          "INSTRUMENT_TOKEN",
          `Instrument resolved (${resolution.source}): token ${resolution.symboltoken}`
        );
      }
    }

    const licence = String(user?.licence || "Live").toLowerCase();
    const endDate = user?.end_date ? new Date(user.end_date) : null;
    if (licence === "live" && endDate && endDate.getTime() < Date.now()) {
      fail("SUBSCRIPTION", "Live subscription expired");
    } else {
      pass("SUBSCRIPTION", "Subscription valid for copy trading");
    }

    const failed = checks.filter((c) => !c.passed);
    const eligible = failed.length === 0;
    const reason = eligible
      ? "Eligible for Alice Blue copy trading"
      : failed.map((f) => f.message).join("; ");

    return {
      userId,
      userName: user?.user_name || null,
      email: user?.email || null,
      broker: "ALICEBLUE",
      eligible,
      reason,
      checks,
    };
  }

  static async validateUsersForSignal(
    signal: {
      _id?: unknown;
      exchange?: string;
      tradingsymbol?: string;
      symboltoken?: string;
    },
    users: any[],
    aliceTokenByUserId?: Map<string, any>
  ): Promise<AliceBroadcastValidationReport> {
    const aliceUsers = users.filter(isAliceUser);
    const exchange = String(signal?.exchange || "NFO").toUpperCase();
    const tradingsymbol = String(signal?.tradingsymbol || "").trim();

    const instrumentPreview = tradingsymbol
      ? await resolveAliceInstrument(exchange, tradingsymbol, signal?.symboltoken)
      : { found: false, symboltoken: "", source: "none" as const, exchange, tradingsymbol };

    const eligible: AliceUserValidationResult[] = [];
    const rejected: AliceUserValidationResult[] = [];

    for (const user of aliceUsers) {
      const userId = String(user._id);
      const result = await this.validateUser(
        user,
        signal,
        aliceTokenByUserId?.get(userId)
      );
      if (result.eligible) eligible.push(result);
      else rejected.push(result);
    }

    log.info("[AliceBlueValidation] Broadcast pre-check complete", {
      signalId: String(signal?._id || ""),
      tradingsymbol,
      exchange,
      totalAliceUsers: aliceUsers.length,
      eligible: eligible.length,
      rejected: rejected.length,
    });

    return {
      signalId: signal?._id ? String(signal._id) : undefined,
      tradingsymbol,
      exchange,
      instrumentResolved: instrumentPreview.found,
      instrumentToken: instrumentPreview.found ? instrumentPreview.symboltoken : undefined,
      eligible,
      rejected,
      summary: {
        totalAliceUsers: aliceUsers.length,
        eligibleCount: eligible.length,
        rejectedCount: rejected.length,
      },
    };
  }

  /**
   * Updates readiness map entries for Alice users based on full validation.
   * Non-Alice entries are untouched (Angel / Upstox / Zerodha unchanged).
   */
  static async applyToReadinessMap(
    signal: any,
    users: any[],
    readinessMap: Map<string, any>,
    aliceTokenByUserId: Map<string, any>
  ): Promise<AliceBroadcastValidationReport> {
    const report = await this.validateUsersForSignal(signal, users, aliceTokenByUserId);

    for (const row of [...report.eligible, ...report.rejected]) {
      const entry = readinessMap.get(row.userId) || {
        userId: row.userId,
        userName: row.userName,
        email: row.email,
        broker: "ALICEBLUE",
        ready: row.eligible,
        reason: row.reason,
      };
      entry.ready = row.eligible;
      entry.reason = row.reason;
      entry.aliceValidation = row;
      readinessMap.set(row.userId, entry);
    }

    return report;
  }

  static async previewForStrategy(
    targetStrategy: string,
    signal?: { exchange?: string; tradingsymbol?: string; symboltoken?: string }
  ): Promise<AliceBroadcastValidationReport> {
    const strategyQuery =
      targetStrategy === "Manual"
        ? {
            $or: [
              { strategies: "Manual" },
              { strategies: { $size: 0 } },
              { strategies: { $exists: false } },
            ],
          }
        : { strategies: { $in: [targetStrategy] } };

    const users = await User.find({
      status: "active",
      trading_status: "enabled",
      broker_connected: true,
      broker: { $regex: /^aliceblue$/i },
      ...strategyQuery,
    })
      .select(
        "user_name email client_key licence end_date broker broker_connected trading_status trading_paused status strategies"
      )
      .lean();

    const AliceTokensModel = require("../models/AliceTokens").default;
    const tokens = await AliceTokensModel.find({
      userId: { $in: users.map((u) => u._id) },
    }).lean();
    const tokenMap = new Map<string, any>();
    for (const t of tokens) tokenMap.set(String(t.userId), t);

    return this.validateUsersForSignal(
      signal || { exchange: "NFO", tradingsymbol: "" },
      users,
      tokenMap
    );
  }
}
