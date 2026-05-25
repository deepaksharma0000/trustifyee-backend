import AngelTokensModel from "../models/AngelTokens";
import UpstoxTokensModel from "../models/UpstoxTokens";
import InstrumentModel from "../models/Instrument";
import UpstoxInstrumentModel from "../models/UpstoxInstrument";
import { UpstoxAdapter } from "../adapters/UpstoxAdapter";
import { config } from "../config";
import log from "../utils/logger";
import { ProfileValidationService } from "./ProfileValidationService";
import { RiskManagementService } from "./RiskManagementService";
import User from "../models/User";
import { decrypt, ensureEncrypted } from "../utils/encryption";
import { recoverSessionByRefreshOrLogin } from "./AngelSessionLifecycleService";
import { getOrCreateAngelAdapter } from "./AngelAdapterRegistry";
import { validateInstrumentFromMaster } from "./InstrumentValidationService";
import { apiKeyFingerprint, buildApiKeyRouteBinding, normalizeIpv4 } from "../utils/apiKeyRouteBinding";
import { eventSourcedOMS } from "./EventSourcedOMS";
import { globalRateLimiter, PriorityClass } from "./GlobalRateLimiter";
import { clockDriftMonitor } from "./ClockDriftMonitor";
import { logLiveExecution } from "../utils/executionAudit";
import { MarketOrderProtection } from "../utils/MarketOrderProtection";
import { normalizeFiniteNumber } from "../utils/price";
import { parseAngelOrderPlacement, parseAngelRows } from "../utils/angelResponseParser";
import { executeWithSessionRecovery } from "./AngelSessionManager";
import {
  assertApiKeyJwtPair,
  buildIpWhitelistDiagnostics,
  logBrokerExecutionContext,
  resolveConsistentApiKey,
} from "./BrokerSessionValidator";


// Removed global adapters to enforce per-user API keys
// const adapter = new AngelOneAdapter();
// const upstoxAdapter = new UpstoxAdapter();

export type PlaceOrderInput = {
  exchange: string;
  tradingsymbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  ordertype?: "MARKET" | "LIMIT";
  transactiontype: "BUY" | "SELL";
  price?: number;
  producttype?: "INTRADAY" | "DELIVERY" | "CARRYFORWARD" | "MARGIN" | "LONGTERM" | "MTF" | "CNC" | "NRML";
  duration?: "DAY" | "IOC";
  symboltoken?: string;
  triggerPrice?: number;
  outgoingIp?: string; // [NEW] Override for isolated nodes
  agentUrl?: string; // [NEW] VPS Agent URL
  dedicatedIpEnabled?: boolean; // [NEW] Allow per-user dedicated routing even in shared VPS mode
  // For dynamic sizing

  isDynamicQty?: boolean;
  riskPercent?: number;
  strategyName?: string;
  strategy?: string;
  correlationId?: string;
  positionId?: string;
  requireLiveExecution?: boolean;
};

function resolveNetworkRouting(orderInput: PlaceOrderInput, user: any) {
  const localBindingEnabled = process.env.ANGEL_ENABLE_LOCAL_BINDING === "true";
  const fromPayloadIp = typeof orderInput.outgoingIp === "string" ? orderInput.outgoingIp.trim() : "";
  const fromProfileIp = typeof user?.outgoing_ip === "string" ? String(user.outgoing_ip).trim() : "";
  const fromPayloadAgent = typeof orderInput.agentUrl === "string" ? orderInput.agentUrl.trim() : "";
  const fromProfileAgent = typeof user?.agent_url === "string" ? String(user.agent_url).trim() : "";
  const dedicatedFromProfile = Boolean(user?.dedicated_ip_enabled === true);
  const dedicatedFromPayload = Boolean((orderInput as any)?.dedicatedIpEnabled === true);
  const dedicatedRoutingEnabled = dedicatedFromPayload || dedicatedFromProfile;
  const hasRouteHints = Boolean(fromPayloadIp || fromProfileIp || fromPayloadAgent || fromProfileAgent);

  if (config.forceSharedVpsRoute && !dedicatedRoutingEnabled) {
    if (hasRouteHints) {
      log.warn("[ORDER_NETWORK] Route hints present but dedicated_ip_enabled=false. Ignoring user-level outgoing_ip/agent_url and forcing shared server route.");
    }
    return {
      outgoingIp: "",
      agentUrl: "",
      usingServerNetworkFallback: true,
      dedicatedRoutingEnabled: false,
    };
  }

  if (!dedicatedRoutingEnabled && hasRouteHints) {
    log.warn("[ORDER_NETWORK] Route hints ignored because dedicated_ip_enabled=false.");
  }

  const outgoingIp = dedicatedRoutingEnabled ? (fromPayloadIp || fromProfileIp || "") : "";
  const agentUrl = dedicatedRoutingEnabled ? (fromPayloadAgent || fromProfileAgent || "") : "";

  if (config.forceSharedVpsRoute && dedicatedRoutingEnabled) {
    log.info("[ORDER_NETWORK] Dedicated user routing override active in shared VPS mode.", {
      clientcodeHint: clientcodeMask(user?.client_key || ""),
      hasOutgoingIp: Boolean(outgoingIp),
      hasAgentUrl: Boolean(agentUrl),
    });
  }

  // Outgoing IP can only be enforced when local binding is enabled or when user has a dedicated agent.
  if (!agentUrl && outgoingIp && !localBindingEnabled) {
    log.warn("[ORDER_NETWORK] outgoing_ip is configured but ANGEL_ENABLE_LOCAL_BINDING is false. Falling back to shared server route.", {
      hasOutgoingIp: true,
      clientcodeHint: clientcodeMask(user?.client_key || ""),
    });
    return {
      outgoingIp: "",
      agentUrl: "",
      usingServerNetworkFallback: true,
      dedicatedRoutingEnabled: false,
    };
  }

  if (!outgoingIp && !agentUrl) {
    // Centralized server execution can still continue if app static IP is whitelisted at API-key level.
    return {
      outgoingIp: "",
      agentUrl: "",
      usingServerNetworkFallback: true,
      dedicatedRoutingEnabled,
    };
  }

  return {
    outgoingIp,
    agentUrl,
    usingServerNetworkFallback: false,
    dedicatedRoutingEnabled,
  };
}

function clientcodeMask(encryptedClientCode: string) {
  try {
    const raw = decrypt(encryptedClientCode);
    if (!raw) return "UNKNOWN";
    if (raw.length <= 4) return raw;
    return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
  } catch {
    return "UNKNOWN";
  }
}

async function enforceApiKeyRoutePairValidation(
  userId: any,
  user: any,
  apiKey: string,
  routing: any,
  clientcode: string
) {
  const strictPrecheck = process.env.STRICT_API_KEY_ROUTE_VALIDATION === "true";
  const licence = String(user?.licence || "").toLowerCase();
  const isExplicitDemo = licence === "demo";
  if (isExplicitDemo) return;

  const baseBinding = buildApiKeyRouteBinding(apiKey, {
    outgoingIp: routing?.outgoingIp,
    agentUrl: routing?.agentUrl,
    dedicatedIpEnabled: Boolean(routing?.dedicatedRoutingEnabled || user?.dedicated_ip_enabled),
  });

  let fallbackRouteIp =
    baseBinding.routeIp ||
    normalizeIpv4(String(user?.validated_route_ip || "")) ||
    normalizeIpv4(String(user?.outgoing_ip || "")) ||
    normalizeIpv4(config.publicIp) ||
    normalizeIpv4(process.env.ANGEL_CLIENT_PUBLIC_IP);

  const binding = {
    ...baseBinding,
    routeIp: fallbackRouteIp,
    routeType:
      baseBinding.routeType !== "UNKNOWN"
        ? baseBinding.routeType
        : fallbackRouteIp
        ? "SERVER_SHARED_IP"
        : "UNKNOWN",
  };

  let isVerified = Boolean(user?.api_key_ip_pair_verified === true);
  let expectedKeyFp = String(user?.validated_api_key_fingerprint || "").trim();
  let expectedRouteIp = String(user?.validated_route_ip || "").trim();
  let expectedRouteType = String(user?.validated_route_type || "").trim();

  if ((!isVerified || !expectedKeyFp || !expectedRouteIp) && binding.routeIp) {
    const bootstrapUpdate = {
      api_key_ip_pair_verified: true,
      validated_api_key_fingerprint: binding.apiKeyFingerprint,
      validated_route_ip: binding.routeIp,
      validated_route_type: binding.routeType,
      validated_pair_at: new Date(),
    };

    try {
      await User.updateOne({ _id: userId }, { $set: bootstrapUpdate });
      Object.assign(user, bootstrapUpdate);
      isVerified = true;
      expectedKeyFp = bootstrapUpdate.validated_api_key_fingerprint;
      expectedRouteIp = bootstrapUpdate.validated_route_ip;
      expectedRouteType = bootstrapUpdate.validated_route_type;
      log.warn("[ORDER_PRECHECK_BOOTSTRAP] Auto-verified missing API key/IP pair from runtime route binding.", {
        clientcode,
        apiKey: binding.apiKeyFingerprint,
        routeIp: binding.routeIp,
        routeType: binding.routeType,
      });
    } catch (bootstrapErr: any) {
      log.warn("[ORDER_PRECHECK_BOOTSTRAP_WARN] Failed persisting bootstrap key/route verification.", {
        clientcode,
        message: bootstrapErr?.message,
      });
    }
  }

  if (!isVerified || !expectedKeyFp || !expectedRouteIp) {
    if (!strictPrecheck) {
      log.warn("[ORDER_PRECHECK_SOFT_BYPASS] Missing key/route verification state. Allowing broker attempt in non-strict mode.", {
        clientcode,
        apiKey: binding.apiKeyFingerprint,
        resolvedRouteIp: binding.routeIp || "UNKNOWN",
        resolvedRouteType: binding.routeType,
        strictPrecheck,
      });
      return;
    }
    throw new Error(
      "API_KEY_ROUTE_NOT_VERIFIED: Reconnect broker once to verify API key and route IP before placing live trades."
    );
  }

  if (expectedKeyFp !== binding.apiKeyFingerprint) {
    if (!strictPrecheck) {
      log.warn("[ORDER_PRECHECK_SOFT_BYPASS] API key fingerprint mismatch. Allowing broker attempt in non-strict mode.", {
        clientcode,
        expectedKeyFp,
        currentKeyFp: binding.apiKeyFingerprint,
      });
      return;
    }
    throw new Error(
      `API_KEY_ROUTE_MISMATCH: API key fingerprint mismatch. expected=${expectedKeyFp}, current=${binding.apiKeyFingerprint}`
    );
  }

  if (expectedRouteIp !== binding.routeIp) {
    if (!strictPrecheck) {
      log.warn("[ORDER_PRECHECK_SOFT_BYPASS] Route IP mismatch. Allowing broker attempt in non-strict mode.", {
        clientcode,
        expectedRouteIp,
        currentRouteIp: binding.routeIp || "UNKNOWN",
      });
      return;
    }
    throw new Error(
      `API_KEY_ROUTE_MISMATCH: Route IP mismatch. expected=${expectedRouteIp}, current=${binding.routeIp || "UNKNOWN"}`
    );
  }

  if (expectedRouteType && expectedRouteType !== "UNKNOWN" && expectedRouteType !== binding.routeType) {
    if (!strictPrecheck) {
      log.warn("[ORDER_PRECHECK_SOFT_BYPASS] Route type mismatch. Allowing broker attempt in non-strict mode.", {
        clientcode,
        expectedRouteType,
        currentRouteType: binding.routeType,
      });
      return;
    }
    throw new Error(
      `API_KEY_ROUTE_MISMATCH: Route type mismatch. expected=${expectedRouteType}, current=${binding.routeType}`
    );
  }

  log.info("[ORDER_PRECHECK_PASS] API key/IP pair validated", {
    clientcode,
    apiKey: binding.apiKeyFingerprint,
    routeIp: binding.routeIp || "UNKNOWN",
    routeType: binding.routeType,
  });
}

async function resolveOrderSymbolToken(orderInput: PlaceOrderInput): Promise<string> {
  const exchange = String(orderInput.exchange || "NFO").toUpperCase().trim();
  const tradingsymbol = String(orderInput.tradingsymbol || "").toUpperCase().trim();
  const requestedToken = String(orderInput.symboltoken || "").trim();

  if (!exchange || !tradingsymbol) {
    throw new Error("Exchange and tradingsymbol are required");
  }

  const validation = await validateInstrumentFromMaster({
    exchange,
    tradingsymbol,
    requestedToken,
    allowExpired: false,
  });

  if (!validation.valid || !validation.symboltoken) {
    throw new Error(`${validation.reason || "SYMBOL_NOT_FOUND_IN_SCRIP_MASTER"}: ${exchange}:${tradingsymbol}`);
  }

  const masterToken = String(validation.symboltoken).trim();
  if (!masterToken) {
    throw new Error(`INVALID_MASTER_SYMBOL_TOKEN: ${exchange}:${tradingsymbol}`);
  }

  if (requestedToken && requestedToken !== masterToken) {
    log.warn("[ORDER_SYMBOL_TOKEN_CORRECTED]", {
      exchange,
      tradingsymbol,
      requestedToken,
      masterToken,
    });
  }

  return masterToken;
}

async function normalizeOrderQuantity(orderInput: PlaceOrderInput): Promise<{ quantity: number; lotSize: number; requestedLots: number }> {
  const requested = Math.max(1, Math.floor(normalizeFiniteNumber(orderInput.quantity, 0)));
  const exchange = String(orderInput.exchange || "NFO").toUpperCase().trim();
  const tradingsymbol = String(orderInput.tradingsymbol || "").toUpperCase().trim();
  const instrument = await InstrumentModel.findOne({ tradingsymbol, exchange }).lean() as any;

  const lotSize = Math.max(1, Math.floor(normalizeFiniteNumber(instrument?.lotSize, 1)));
  const isDerivative = ["NFO", "BFO", "NSE_FO", "BSE_FO"].includes(exchange);
  const quantity = isDerivative && requested < lotSize ? requested * lotSize : requested;

  return { quantity, lotSize, requestedLots: requested };
}

/**
 * Robust Pre-Trade Validation Wrapper
 */
async function runPreTradeValidation(userId: string, clientcode: string, orderInput: PlaceOrderInput, retryCount = 0): Promise<{ status: boolean; data?: any; message: string }> {
  // 1. Profile Validation (Includes NFO permission check)
  let profileRes = await ProfileValidationService.validateUserSession(userId, clientcode);
  
  // 🔄 [ISSUE 1 FIX] - Handle Token Expiry during validation
  if (!profileRes.status && (profileRes.message.toLowerCase().includes("invalid token") || profileRes.message.includes("AG8001")) && retryCount < 1) {
      log.info(`[OrderService] Token expired during validation for ${clientcode}. Attempting refresh...`);
      const refreshed = await attemptTokenRefresh(userId, clientcode);
      if (refreshed) {
          log.info(`[OrderService] Validation retry after refresh for ${clientcode}`);
          return runPreTradeValidation(userId, clientcode, orderInput, retryCount + 1);
      }
  }

  if (!profileRes.status) return profileRes;

  // Validate and normalize symboltoken against local live scrip master.
  orderInput.symboltoken = await resolveOrderSymbolToken(orderInput);

  // 2. Risk Management (Margin Check)
  const marginRes = await RiskManagementService.getAvailableMargin(userId, clientcode);
  // [FIX] Don't block the trade if RMS fetch fails, let the broker decide during order placement
  if (!marginRes.status || !marginRes.data) {
      log.warn(`RMS_FETCH_WARNING: Skipping margin check for ${clientcode} due to broker error: ${marginRes.message}`);
  }

  // 3. Dynamic Quantity Calculation if requested
  if (orderInput.isDynamicQty && orderInput.riskPercent) {
      // We need LTP for calculation
      try {
          const tokens = await AngelTokensModel.findOne({ userId, clientcode });
          if (!tokens?.apiKey) throw new Error("API Key missing in tokens");
          
          const decJwtToken = await ensureEncrypted(tokens, 'jwtToken', `user_${userId}_ltp_val`);
          const userApiKey = await ensureEncrypted(tokens, 'apiKey', `user_${userId}_ltp_check`);
          
          const ltpAdapter = getOrCreateAngelAdapter(userApiKey);
          const ltpRes = await ltpAdapter.getLtp(decJwtToken, orderInput.exchange || "NFO", orderInput.tradingsymbol, orderInput.symboltoken || "");
          const ltp = Number(ltpRes?.data?.ltp || 0);
          
          const instrument = await InstrumentModel.findOne({ tradingsymbol: orderInput.tradingsymbol, exchange: orderInput.exchange || "NFO" }).lean() as any;
          const lotSize = instrument?.lotSize || 1;

          if (ltp > 0 && marginRes.data) {
              const newQty = RiskManagementService.calculateDynamicQuantity(marginRes.data.availablecash, orderInput.riskPercent, ltp, lotSize);
              log.info(`DYNAMIC_SIZE: Recalculated Qty ${orderInput.quantity} -> ${newQty} for ${clientcode}`);
              orderInput.quantity = newQty;
          } else if (ltp > 0) {
              log.warn(`DYNAMIC_SIZE_SKIP: Skipping dynamic resizing for ${clientcode} because margin info is missing.`);
          }
      } catch (e) {
          log.warn("Dynamic sizing failed, using original qty:", (e as any).message);
      }
  }

  if (orderInput.quantity <= 0) {
      return { status: false, message: "Calculated quantity is zero. Trade blocked." };
  }

  // 4. Margin Sufficiency Check
  const requiredAmount = (orderInput.price || 0) * orderInput.quantity; // Simplistic
  if (requiredAmount > 0 && marginRes.data && !RiskManagementService.checkMarginSufficient(marginRes.data.totalusablemargin, requiredAmount)) {
      log.error(`TRADE_BLOCKED: Insufficient usable margin for ${clientcode}. Required: ${requiredAmount}`);
      return { status: false, message: "MARGIN_INSUFFICIENT" };
  } else if (requiredAmount > 0 && !marginRes.data) {
      log.warn(`MARGIN_CHECK_SKIP: Placing order for ${clientcode} without margin sufficiency check (broker data missing).`);
  }

  // 5. Network route note (non-blocking)
  if (!orderInput.outgoingIp && !orderInput.agentUrl) {
      log.warn(`[ORDER_NETWORK_FALLBACK] ${clientcode} has no dedicated outgoing_ip/agent_url. Falling back to server network path.`);
  }

  return { status: true, message: "" };
}

export async function placeOrderForClient(
  userId: any,
  clientcode: string,
  orderInput: PlaceOrderInput,
  retryCount = 0
): Promise<any> {
  // 🛡️ INTERNAL GUARD: Ensure only called from trusted internal service
  // In production, we'd check for a system secret or specific caller context.
  log.debug(`[OrderService] Server-side order attempt for ${clientcode}.`);


  let user = await User.findById(userId);
  const isEndUser = Boolean(user);
  
  if (!user) {
    // If not in User collection, check Admin collection (for admin broadcast)
    const AdminModel = require('../models/Admin').default;
    user = await AdminModel.findById(userId);
  }

  if (!user) {
     log.error(`[OrderService] User/Admin not found for ID: ${userId}`);
     throw new Error("User not found");
  }

  if (user!.trading_paused) {
      log.warn(`TRADE_BLOCKED: Trading is paused for ${user!.user_name} due to ${user!.consecutive_failures} consecutive failures. Status: TRADING_PAUSED_BY_SYSTEM`);
      return { status: false, message: "TRADING_PAUSED_BY_SYSTEM" };
  }

  // 🛡️ [GLOBAL OPERATIONAL FEATURE FLAGS & EMERGENCY KILL SWITCH]
  const { systemConfigManager } = require("./SystemConfigManager");
  const flags = systemConfigManager.getSnapshot();

  const isExit = orderInput.side === "SELL" || (orderInput as any).isExit;
  const isEntry = !isExit;

  if (flags.EMERGENCY_KILL_SWITCH && isEntry) {
      log.error(`[EMERGENCY_KILL_SWITCH] Blocked new entry order for ${clientcode} - global kill switch engaged.`);
      throw new Error("EMERGENCY_KILL_SWITCH_ENGAGED: New entry orders are suspended by system administrators.");
  }

  if (flags.SAFE_MODE_GLOBAL && isEntry) {
      log.error(`[SAFE_MODE_GLOBAL] Blocked new entry order for ${clientcode} - Global Safe Mode active.`);
      throw new Error("SAFE_MODE_GLOBAL_ACTIVE: Global Safe Mode is active. New entry orders are suspended.");
  }

  if (flags.BROKER_DISABLED) {
      log.error(`[BROKER_DISABLED] Blocked outbound order for ${clientcode} - Broker connections disabled.`);
      throw new Error("BROKER_CONNECTIONS_DISABLED: All outbound broker execution has been temporarily suspended by administrators.");
  }

  if (!flags.LIVE_TRADING_ENABLED && !flags.PAPER_ONLY_MODE && !flags.SHADOW_ONLY_MODE) {
      log.error(`[LIVE_TRADING_DISABLED] Blocked order for ${clientcode} - Live trading is disabled globally.`);
      throw new Error("LIVE_TRADING_DISABLED: Outbound live trading is suspended globally.");
  }

  log.debug(`[OrderService] Attempting order for ${clientcode}. Current Failures: ${user!.consecutive_failures || 0}`);

  // 🛡️ [MARKET ORDER PROTECTION & COMPLIANCE]
  // 🛡️ [IP WHITELIST HARD SAFETY GUARD]
  const { StartupDiagnostics } = require("../utils/startupDiagnostics");
  
  // Force paper trading if paper only or shadow mode is globally active, or if running in staging/development
  const isStagingEnv = process.env.NODE_ENV !== "production";
  const requireLiveExecution = Boolean((orderInput as any)?.requireLiveExecution === true);
  const licence = (flags.PAPER_ONLY_MODE || flags.SHADOW_ONLY_MODE || isStagingEnv) 
      ? "paper" 
      : String(user!.licence || "").toLowerCase();

  if (isStagingEnv) {
      log.info(`[ENVIRONMENT_ISOLATION] Running in non-production environment: forcing paper trading for safety.`);
  }

  if (flags.SHADOW_ONLY_MODE) {
      log.info(`[SHADOW_ONLY_MODE] Running shadow-only execution for ${clientcode}. Real order will execute via Paper Simulator.`);
  }
  
  if (StartupDiagnostics.whitelistMismatchExists && licence === "live") {
      log.error(`[SAFETY_PROTECTION] Whitelist IP mismatch exists on startup. Blocking LIVE order for client ${clientcode} on ${user!.broker}.`);
      const { AlertService } = require("./AlertService");
      await AlertService.trigger(
          "WHITELIST_MISMATCH_LIVE_BLOCKED",
          `CRITICAL: Whitelist mismatch active. LIVE order blocked for user ID ${userId} (${clientcode}, broker: ${user!.broker}). Outbound IP: ${StartupDiagnostics.detectedOutboundIp}, Configured Whitelisted IP: ${config.publicIp}`,
          "CRITICAL"
      );
      throw new Error(
        `LIVE_EXECUTION_BLOCKED_WHITELIST_MISMATCH: outbound=${StartupDiagnostics.detectedOutboundIp}, configured=${config.publicIp}`
      );
  }

  if (licence === "paper") {
      if (requireLiveExecution) {
        throw new Error("LIVE_EXECUTION_REQUIRED: execution is currently in paper mode for this user/system configuration.");
      }

      log.info(`[PAPER_SIMULATOR] Routing order for ${clientcode} to Paper Trading Simulator.`);

      // Call Paper Simulator
      const { paperTradingSimulator } = require("./PaperTradingSimulator");
      
      const paperOrderId = (orderInput as any).clientOrderId || `PAPER-${clientcode}-${Date.now().toString().slice(-6)}`;
      await paperTradingSimulator.submitOrder({
          clientOrderId: paperOrderId,
          tradingsymbol: (orderInput as any).tradingsymbol,
          exchange: (orderInput as any).exchange || "NFO",
          side: (orderInput as any).side || "BUY",
          quantity: (orderInput as any).quantity,
          ordertype: (orderInput as any).ordertype || "MARKET",
          price: (orderInput as any).price,
      });

      return {
          status: true,
          data: {
              orderid: paperOrderId,
              message: "Executed via Paper Trading Simulator",
              executionMode: "paper",
              simulated: true,
          }
      };
  }

  // 🚀 [BROKER ROUTING]
  const routing = resolveNetworkRouting(orderInput, user);
  const currentIp = routing.outgoingIp || undefined;
  const currentAgentUrl = routing.agentUrl || undefined;

  if (routing.usingServerNetworkFallback) {
      log.warn(`[ORDER_NETWORK_FALLBACK] ${clientcode} executing via server network (no user-specific IP/agent).`);
  }

  // 1. [UPSTOX]
  if (user!.broker === "Upstox") {
      try {
          const { placeOptionOrder } = await import("./orderServices");
          const upstoxTokens = await UpstoxTokensModel.findOne({ userId });
          if (!upstoxTokens?.accessToken) throw new Error("No active Upstox session");

          const upstoxResp = await placeOptionOrder(
              orderInput.symboltoken || "",
              orderInput.quantity, // lots logic happens inside orderServices
              orderInput.side,
              orderInput.ordertype || "MARKET",
              orderInput.price,
              decrypt(upstoxTokens.accessToken),
              currentIp // [FIX 2] Pass IP
          );

          log.info(`PLACE_ORDER_UPSTOX_SUCCESS: ${clientcode} - ${orderInput.tradingsymbol}`);
          return { status: true, data: upstoxResp };
      } catch (err: any) {
          log.error(`UPSTOX_ORDER_FAILURE: ${clientcode} - ${err.message}`);
          throw err;
      }
  }

  // 2. [ALICEBLUE]
  if (user!.broker === "AliceBlue") {
    try {
      const { placeAliceOrderForClient } = await import("./AliceOrderService");
      const aliceResp = await placeAliceOrderForClient(clientcode, {
        exchange: orderInput.exchange,
        tradingsymbol: orderInput.tradingsymbol,
        side: orderInput.side,
        transactiontype: orderInput.transactiontype,
        quantity: orderInput.quantity,
        ordertype: orderInput.ordertype,
        price: orderInput.price,
        symboltoken: orderInput.symboltoken,
        triggerPrice: orderInput.triggerPrice,
        outgoingIp: currentIp // [FIX 2] Pass IP
      });

      if (aliceResp && (aliceResp.status === "Ok" || aliceResp.stat === "Ok")) {
        user!.consecutive_failures = 0;
        await user!.save();
        log.info(`PLACE_ORDER_ALICE_SUCCESS: ${clientcode} - ${orderInput.tradingsymbol}`);
        return { status: true, data: aliceResp };
      } else {
        throw new Error(aliceResp?.message || aliceResp?.emsg || "Alice Blue rejected order");
      }
    } catch (err: any) {
      log.error(`ALICE_ORDER_FAILURE: ${clientcode} - ${err.message}`);
      user!.consecutive_failures = (user!.consecutive_failures || 0) + 1;
      if (user!.consecutive_failures >= config.circuitBreakerThreshold) {
        user!.trading_paused = true;
      }
      await user!.save();
      return { status: false, message: err.message };
    }
  }

  // 😇 [DEFAULT / ANGELONE FLOW] - Unmodified production logic
  let clientOrderId = "";
  try {
      // 1. Run Validations
      const normalizedQty = await normalizeOrderQuantity(orderInput);
      if (normalizedQty.quantity !== orderInput.quantity) {
        log.info("[ORDER_QUANTITY_NORMALIZED]", {
          clientcode,
          tradingsymbol: orderInput.tradingsymbol,
          requestedLots: normalizedQty.requestedLots,
          lotSize: normalizedQty.lotSize,
          brokerQuantity: normalizedQty.quantity,
        });
        orderInput.quantity = normalizedQty.quantity;
      }

      const validation = await runPreTradeValidation(user!._id.toString(), clientcode, {
        ...orderInput,
        outgoingIp: currentIp,
        agentUrl: currentAgentUrl
      });
      if (!validation.status) {
          throw new Error(validation.message || "Validation failed");
      }

      // 2. Fetch tokens and resolve API Key
      const angelTokens = await AngelTokensModel.findOne({ userId, clientcode });
      if (!angelTokens?.jwtToken) throw new Error("No Angel session");



      // 🚀 [PRE-EXECUTION GUARD] - Fall fast if state is invalid
      const decJwtToken = await ensureEncrypted(angelTokens, 'jwtToken', `user_${userId}_order`);
      const apiKeyResolution = await resolveConsistentApiKey({
        angelTokens,
        profile: user,
        userId: String(userId),
        clientcode,
      });
      const resolvedApiKey = apiKeyResolution.apiKey;

      if (!resolvedApiKey || resolvedApiKey.length < 5) {
          log.error(`[ORDER_BLOCKED_INVALID_STATE] Invalid API Key for ${clientcode}`);
          throw new Error("Invalid or missing API key. Please reconnect broker with your own SmartAPI app key.");
      }
      if (!decJwtToken || decJwtToken.length < 20) {
          log.error(`[ORDER_BLOCKED_INVALID_STATE] Invalid session token for ${clientcode}`);
          throw new Error("Invalid session. Please login to your broker again.");
      }

      if (apiKeyResolution.mismatchDetected) {
        log.warn("[ORDER_API_KEY_MISMATCH_RECONNECT_REQUIRED] JWT was issued with a different SmartAPI app key. Forcing broker reconnect.", {
          clientcode,
          chosenSource: apiKeyResolution.source,
        });
        throw new Error(
          "BROKER_API_KEY_TOKEN_MISMATCH: API key changed since last login. Reconnect broker from profile settings."
        );
      }

      assertApiKeyJwtPair(resolvedApiKey, decJwtToken, clientcode);

      logBrokerExecutionContext({
        userId: String(userId),
        clientCode: clientcode,
        broker: "ANGELONE",
        purpose: "order_place_precheck",
        apiKeyLast4: resolvedApiKey.slice(-4),
        apiKeyFingerprint: apiKeyFingerprint(resolvedApiKey),
        apiKeySource: apiKeyResolution.source,
        requestIp: currentIp || config.publicIp || "SERVER_SHARED_IP",
        routeType: routing.dedicatedRoutingEnabled ? "DEDICATED" : "SERVER_SHARED_IP",
        tokenOwner: String(userId),
        executionMode: config.executionMode,
        sessionConsistent: !apiKeyResolution.mismatchDetected,
      });

      log.info("[IP_WHITELIST_DIAGNOSTICS]", buildIpWhitelistDiagnostics({
        dedicatedIpEnabled: routing.dedicatedRoutingEnabled,
        userOutgoingIp: (user as any)?.outgoing_ip,
      }));

      if (isEndUser) {
        await enforceApiKeyRoutePairValidation(userId, user, resolvedApiKey, routing, clientcode);
      }

      // Enforce SEBI/NSE compliance and market order protection
      const protectionResult = await MarketOrderProtection.enforceProtection(
        orderInput,
        decJwtToken,
        resolvedApiKey
      );

      const correlationId = (orderInput as any).correlationId || `corr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const positionId = (orderInput as any).positionId || `pos_${orderInput.symboltoken || 'unknown'}`;
      const strategyRunId = orderInput.strategyName || orderInput.strategy || "Manual";

      clientOrderId = eventSourcedOMS.generateClientOrderId(
        correlationId,
        positionId,
        orderInput.side,
        strategyRunId
      );

      // Write-Ahead Intent and Creation Logging with COMPLIANCE METADATA
      await eventSourcedOMS.appendEvent(clientOrderId, "PENDING_BROKER", "INTENT_LOGGED", {
        userId: userId.toString(),
        tradingsymbol: orderInput.tradingsymbol,
        exchange: orderInput.exchange,
        side: orderInput.side,
        quantity: orderInput.quantity,
        positionId,
        strategyRunId,
        compliance: {
          originalType: protectionResult.originalType,
          executedType: protectionResult.ordertype,
          slippagePercent: protectionResult.slippagePercent,
          referenceLtp: protectionResult.ltp,
          routeType: routing.dedicatedRoutingEnabled ? "DEDICATED" : "SHARED",
          routeIp: routing.outgoingIp || "SERVER_SHARED_IP",
        }
      });

      await eventSourcedOMS.appendEvent(clientOrderId, "PENDING_BROKER", "CREATED", {
        userId: userId.toString(),
        tradingsymbol: orderInput.tradingsymbol,
        exchange: orderInput.exchange,
        side: orderInput.side,
        quantity: orderInput.quantity,
        positionId,
        strategyRunId,
        compliance: {
          originalType: protectionResult.originalType,
          executedType: protectionResult.ordertype,
          slippagePercent: protectionResult.slippagePercent,
          referenceLtp: protectionResult.ltp,
          routeType: routing.dedicatedRoutingEnabled ? "DEDICATED" : "SHARED",
          routeIp: routing.outgoingIp || "SERVER_SHARED_IP",
        }
      });

      // 🚀 [RATE LIMITING] - Enforce priority capacity reservation before external broker request
      let priority: PriorityClass = "ENTRY";
      if ((orderInput as any).priority) {
        priority = (orderInput as any).priority;
      } else if (orderInput.side === "SELL" || (orderInput as any).isExit) {
        priority = "CRITICAL_EXIT";
      }

      const fp = apiKeyFingerprint(resolvedApiKey);
      const acquired = await globalRateLimiter.acquire(fp, priority);
      if (!acquired) {
        log.error(`[RateLimiter] Throttling order for ${clientcode} - Priority: ${priority}`);
        throw new Error(`RATE_LIMIT_EXCEEDED: Execution capacity exceeded for priority ${priority}`);
      }

      // 🛡️ [STARTUP CIRCUIT BREAKER PROTECTION] - Suspend new entries under SAFE_BOOT_MODE
      const isEntry = priority === "ENTRY";
      if (isEntry) {
        try {
          const { StartupDiagnostics } = require("../utils/startupDiagnostics");
          if (StartupDiagnostics.isSafeBootMode()) {
            log.error(`[StartupCircuitBreaker] Blocked entry order placement for ${clientcode} due to active SAFE_BOOT_MODE`);
            throw new Error("STARTUP_SAFETY_ALERT: New entry orders are suspended because the system is running in SAFE_BOOT_MODE.");
          }
        } catch (diagErr: any) {
          if (diagErr.message.includes("STARTUP_SAFETY_ALERT")) {
            throw diagErr;
          }
        }
      }

      // 🛡️ [CLOCK DRIFT SAFETY MODE] - Suspend new entries under temporal degradation modes
      if (isEntry && !clockDriftMonitor.isEntryAllowed()) {
        const currentMode = clockDriftMonitor.getSafetyMode();
        log.error(`[ClockDriftSafety] Blocked entry order placement for ${clientcode} due to safety mode: ${currentMode}`);
        throw new Error(`TEMPORAL_SAFETY_ALERT: New entry orders are suspended under safety mode: ${currentMode}`);
      }

      if (!clockDriftMonitor.isExitAllowed()) {
        log.error(`[ClockDriftSafety] Blocked exit order placement for ${clientcode} due to extreme safety mode: READ_ONLY_MODE`);
        throw new Error(`TEMPORAL_SAFETY_ALERT: Order placements are suspended under safety mode: READ_ONLY_MODE`);
      }

      // 🚀 [FIX 2] Pass outgoingIp and agentUrl to AngelOneAdapter
      // 3. Place Order using Protection Result
      const txType = orderInput.side?.toUpperCase() as "BUY" | "SELL";
      const payload = {
        variety: "NORMAL",
        tradingsymbol: orderInput.tradingsymbol,
        symboltoken: orderInput.symboltoken,
        transactiontype: txType,
        exchange: orderInput.exchange || "NFO",
        ordertype: protectionResult.ordertype, // Enforced "LIMIT" type
        producttype: orderInput.producttype || "INTRADAY",
        duration: orderInput.duration || "DAY",
        price: protectionResult.price,         // Enforced slippage protected price
        quantity: String(orderInput.quantity),
        squareoff: "0",
        stoploss: "0",
        clientref: clientOrderId
      };

      log.info("[PLACE_ORDER_PAYLOAD]", {
        userId: String(userId),
        clientcode,
        hasClientKey: Boolean((user as any)?.client_key),
        hasPassword: Boolean((user as any)?.broker_password),
        hasTotpSecret: Boolean((user as any)?.broker_totp_secret),
        hasJwtToken: Boolean(decJwtToken),
        hasFeedToken: Boolean((angelTokens as any)?.feedToken),
        apiKey: apiKeyFingerprint(resolvedApiKey),
        routeType: routing.dedicatedRoutingEnabled ? "DEDICATED" : "SHARED",
        usedIp: currentIp || "SERVER_SHARED_IP",
        payload,
      });

      // Use dynamic adapter instance with the correct API key and optional agent
      const resp = await executeWithSessionRecovery(
        {
          userId: String(userId),
          clientcode,
          purpose: "order_place",
          outgoingIp: currentIp,
          agentUrl: currentAgentUrl,
        },
        (session) => session.adapter.placeOrder(session.jwtToken, payload)
      );
      const parsedOrder = parseAngelOrderPlacement(resp);

      log.info("[PLACE_ORDER_RESPONSE]", {
        userId: String(userId),
        clientcode,
        tradingsymbol: orderInput.tradingsymbol,
        statusCode: resp?.status,
        brokerStatus: resp?.data?.status ?? resp?.data?.success,
        errorCode: parsedOrder.errorCode,
        message: parsedOrder.brokerMessage,
        orderId: parsedOrder.brokerOrderId || null,
        uniqueOrderId: parsedOrder.uniqueOrderId || null,
      });

      const brokerData = resp?.data || {};
      const brokerCode = parsedOrder.errorCode.toUpperCase();
      const brokerMessage = parsedOrder.brokerMessage;
      const isInvalidTokenPayload =
        brokerCode === "AG8001" ||
        brokerCode === "AG8004" ||
        brokerMessage.toLowerCase().includes("invalid token") ||
        brokerMessage.toLowerCase().includes("invalid api key");

      if (isInvalidTokenPayload) {
          const errLabel = brokerCode === "AG8004" ? "AG8004 Invalid API Key" : "AG8001 Invalid Token";
          throw new Error(`${errLabel}: ${brokerMessage || "Broker session invalid"}`);
      }

      // Reset failures on success
      if (resp && resp.status === 200 && parsedOrder.accepted) {
          const brokerOrderId = parsedOrder.brokerOrderId || parsedOrder.uniqueOrderId || "PENDING";
          await eventSourcedOMS.appendEvent(clientOrderId, brokerOrderId, "SUBMITTED", {
            brokerOrderId,
          });
          await eventSourcedOMS.appendEvent(clientOrderId, brokerOrderId, "ACKNOWLEDGED", {
            brokerOrderId,
          });

          // [ISSUE 2 FIX] Atomic reset in DB + In-memory update
          const successUpdate: any = {
            consecutive_failures: 0,
            trading_paused: false,
          };

          if (isEndUser) {
            const successBaseBinding = buildApiKeyRouteBinding(resolvedApiKey, {
              outgoingIp: routing?.outgoingIp,
              agentUrl: routing?.agentUrl,
              dedicatedIpEnabled: Boolean(routing?.dedicatedRoutingEnabled || (user as any)?.dedicated_ip_enabled),
            });
            const successRouteIp =
              successBaseBinding.routeIp ||
              normalizeIpv4(String((user as any)?.outgoing_ip || "")) ||
              normalizeIpv4(config.publicIp) ||
              normalizeIpv4(process.env.ANGEL_CLIENT_PUBLIC_IP) ||
              null;
            const successRouteType =
              successBaseBinding.routeType !== "UNKNOWN"
                ? successBaseBinding.routeType
                : successRouteIp
                ? "SERVER_SHARED_IP"
                : "UNKNOWN";
            successUpdate.api_key_ip_pair_verified = true;
            successUpdate.validated_api_key_fingerprint = successBaseBinding.apiKeyFingerprint;
            successUpdate.validated_route_ip = successRouteIp;
            successUpdate.validated_route_type = successRouteType;
            successUpdate.validated_pair_at = new Date();
          }

          await User.updateOne({ _id: userId }, { $set: successUpdate });
          if (user) {
              user.consecutive_failures = 0;
              user.trading_paused = false;
              if (isEndUser) {
                const successBaseBinding = buildApiKeyRouteBinding(resolvedApiKey, {
                  outgoingIp: routing?.outgoingIp,
                  agentUrl: routing?.agentUrl,
                  dedicatedIpEnabled: Boolean(routing?.dedicatedRoutingEnabled || (user as any)?.dedicated_ip_enabled),
                });
                const successRouteIp =
                  successBaseBinding.routeIp ||
                  normalizeIpv4(String((user as any)?.outgoing_ip || "")) ||
                  normalizeIpv4(config.publicIp) ||
                  normalizeIpv4(process.env.ANGEL_CLIENT_PUBLIC_IP) ||
                  null;
                const successRouteType =
                  successBaseBinding.routeType !== "UNKNOWN"
                    ? successBaseBinding.routeType
                    : successRouteIp
                    ? "SERVER_SHARED_IP"
                    : "UNKNOWN";
                (user as any).api_key_ip_pair_verified = true;
                (user as any).validated_api_key_fingerprint = successBaseBinding.apiKeyFingerprint;
                (user as any).validated_route_ip = successRouteIp;
                (user as any).validated_route_type = successRouteType;
                (user as any).validated_pair_at = new Date();
              }
          }
          log.info(`PLACE_ORDER_BROKER_SUCCESS: ${clientcode} - ${orderInput.tradingsymbol}`);
          return resp;
      } else {
          const reject = {
            success: false,
            brokerOrderId: parsedOrder.brokerOrderId,
            rejectionReason: parsedOrder.rejectionReason || brokerMessage || "Broker rejected order",
            brokerMessage,
            errorCode: parsedOrder.errorCode,
            rawResponse: parsedOrder.rawResponse,
          };
          log.warn("[PLACE_ORDER_BROKER_REJECTED]", {
            userId: String(userId),
            clientcode,
            tradingsymbol: orderInput.tradingsymbol,
            ...reject,
          });
          return {
            status: false,
            message: reject.rejectionReason,
            errorCode: reject.errorCode,
            data: reject,
          };
      }

  } catch (err: any) {
      log.error(`ORDER_FAILURE [Attempt ${retryCount + 1}]: ${clientcode} - ${err.message}`);

      // 🛡️ [FATAL ERROR GUARD]
      if (err.message === "INVALID_MPIN_FATAL" || err.isFatal) {
          log.error(`[ORDER_FATAL] Stopping execution for ${clientcode} due to invalid MPIN/credentials.`);
          user!.trading_paused = true; // Block further attempts
          await user!.save();
          return { status: false, message: "INVALID_CREDENTIALS_PERMANENT" };
      }

      // 🔄 [AUTO-REFRESH TOKEN LOGIC]
      const isInvalidToken = err.message.toLowerCase().includes("invalid token") || err.message.includes("AG8001");
      const isApiKeyIpMismatch = /(api key mismatch against app found with static ip in request|unregistered ip|register your ip before retrying)/i.test(
        String(err.message || "")
      );
      const isApiKeyRoutePrecheck = /^API_KEY_ROUTE_(NOT_VERIFIED|MISMATCH)/i.test(
        String(err.message || "")
      );
      const isLiveExecutionRequired = /^LIVE_EXECUTION_REQUIRED:/i.test(String(err.message || ""));
      const isWhitelistLiveBlocked = /^LIVE_EXECUTION_BLOCKED_WHITELIST_MISMATCH:/i.test(
        String(err.message || "")
      );
      
      if (isInvalidToken && retryCount < 1) {
          log.info(`[OrderService] Token expired for ${clientcode}. Attempting auto-refresh...`);
          const refreshed = await attemptTokenRefresh(userId, clientcode);
          if (refreshed) {
              log.info(`[OrderService] Token refreshed successfully for ${clientcode}. Retrying order...`);
              return placeOrderForClient(userId, clientcode, orderInput, retryCount + 1);
          }
      }

      if (isApiKeyIpMismatch) {
          if (isEndUser) {
            try {
              await User.updateOne(
                { _id: userId },
                {
                  $set: {
                    api_key_ip_pair_verified: false,
                  },
                }
              );
              (user as any).api_key_ip_pair_verified = false;
            } catch (stateErr: any) {
              log.warn("[ORDER_PRECHECK_STATE_WARN] Failed to mark api_key_ip_pair_verified=false after broker static IP mismatch.", {
                clientcode,
                message: stateErr?.message,
              });
            }
          }
          log.error(`[ORDER_NO_RETRY] API key/static IP mismatch for ${clientcode}. Blocking retries until key/IP mapping is fixed.`);
          return { status: false, message: err.message };
      }

      if (isApiKeyRoutePrecheck) {
          log.error(`[ORDER_NO_RETRY] API key/route precheck failed for ${clientcode}.`, {
            message: err.message,
          });
          return { status: false, message: err.message };
      }

      if (isLiveExecutionRequired) {
          log.error(`[ORDER_NO_RETRY] Live execution required for ${clientcode}.`, {
            message: err.message,
          });
          return { status: false, message: err.message };
      }

      if (isWhitelistLiveBlocked) {
          log.error(`[ORDER_NO_RETRY] Live execution blocked by whitelist mismatch for ${clientcode}.`, {
            message: err.message,
          });
          return { status: false, message: err.message };
      }

      // Generic Retry Logic (Only for Angel One)
      if (retryCount < 1 && !isInvalidToken) { 
          return placeOrderForClient(userId, clientcode, orderInput, retryCount + 1);
      }

      if (clientOrderId) {
        await eventSourcedOMS.appendEvent(clientOrderId, "FAILED_BROKER", "FAILED", {
          error: err.message,
        });
      }

      // 🛡️ [CIRCUIT BREAKER] - Use atomic increment to avoid race conditions
      const updatedUser = await User.findOneAndUpdate(
          { _id: userId },
          { $inc: { consecutive_failures: 1 } },
          { new: true }
      );

      if (updatedUser && updatedUser.consecutive_failures >= config.circuitBreakerThreshold) {
          await User.updateOne({ _id: userId }, { $set: { trading_paused: true } });
          log.error(`CIRCUIT_BREAKER_TRIGGERED: Pausing trading for ${user!.user_name} (Total Failures: ${updatedUser.consecutive_failures})`);
      }

      return { status: false, message: err.message };
  }
}

/**
 * 🔄 Helper to attempt token refresh
 */
async function attemptTokenRefresh(userId: string, clientcode: string): Promise<boolean> {
    try {
        const angelTokens = await AngelTokensModel.findOne({ userId, clientcode });
        if (!angelTokens) return false;

        const recovered = await recoverSessionByRefreshOrLogin(angelTokens, "order_service");
        if (!recovered.ok || !recovered.jwtToken) {
            log.warn(`[OrderService] Session recovery failed for ${clientcode}: ${recovered.reason || "unknown"}`);
            return false;
        }
        return true;
    } catch (err: any) {
        log.error(`[OrderService] Token refresh attempt failed for ${clientcode}: ${err.message}`);
        return false;
    }
}

export async function getOrderStatusForClient(
  userId: string | unknown,
  clientcode: string,
  orderId: string,
  outgoingIp?: string,
  symbolMatch?: string // Optional: Find by symbol if orderId is synthetic
) {
  const angelTokens = await AngelTokensModel.findOne({ userId, clientcode }).lean() as any;
  if (angelTokens?.jwtToken) {
    const orderBookResp = await executeWithSessionRecovery(
      {
        userId: String(userId || ""),
        clientcode,
        purpose: "order_book_status",
        outgoingIp,
      },
      (session) => session.adapter.getOrderBook(session.jwtToken)
    );
    const parsedRows = parseAngelRows(orderBookResp);
    const orderRows = parsedRows.rows;
    if (orderBookResp && orderBookResp.status === 200 && parsedRows.ok) {
      // 1. Try exact Match
      let order = orderRows.find((o: any) => String(o.orderid || "") === String(orderId || ""));
      
      // 2. Try Fuzzy Match if ID is synthetic (internal client IDs)
      const isSyntheticId = !/^\d+$/.test(String(orderId || "").trim());
      if (!order && isSyntheticId && symbolMatch) {
          log.info(`Fuzzy matching orderbook for ${symbolMatch} (synthetic ID: ${orderId})`);
          // Find most recent order with matching symbol
          order = [...orderRows].reverse().find((o: any) => 
            String(o.tradingsymbol || "").toUpperCase() === String(symbolMatch || "").toUpperCase() && 
            ["COMPLETE", "OPEN", "TRIGGER PENDING", "PARTIALLY FILLED"].includes(
              String(o.orderstatus || o.status || "").toUpperCase()
            )
          );
      }

      if (order) return { status: true, data: order };
    }
    
    // If exact ID lookup is possible (not our UUID)
    if (!orderId.startsWith("BROKER-")) {
        // Reuse dynamicAdapter created above (it's in scope if we refactor slightly, but for now just use the one we have or create new)
        const statusResp = await executeWithSessionRecovery(
          {
            userId: String(userId || ""),
            clientcode,
            purpose: "order_status",
            outgoingIp,
          },
          (session) => session.adapter.getOrderStatus(session.jwtToken, orderId)
        );
        const parsedStatus = parseAngelOrderPlacement(statusResp);
        if (parsedStatus.data && typeof parsedStatus.data === "object") {
          return { status: true, data: parsedStatus.data };
        }
        if (parsedStatus.rejected) {
          return {
            status: false,
            message: parsedStatus.rejectionReason || parsedStatus.brokerMessage || "Order status rejected by broker",
            errorCode: parsedStatus.errorCode,
            data: parsedStatus.rawResponse,
          };
        }
        return statusResp;
    }
    
    return { status: false, message: "Order not found in broker book" };
  }

  const upstoxTokens = await UpstoxTokensModel.findOne({ userId }).lean() as any;
  if (upstoxTokens?.accessToken) {
    // Upstox order status usually via order history or specific ID
    // Simplification for now
    return { status: true, data: { status: "unknown", message: "Upstox status check pending" } };
  }

  throw new Error("No active session for this user");
}

export async function fetchBrokerOrder(
  userId: string | unknown,
  clientcode: string,
  clientOrderId: string,
  outgoingIp?: string,
  symbolMatch?: string
) {
  try {
    const resp = await getOrderStatusForClient(userId, clientcode, clientOrderId, outgoingIp, symbolMatch);
    if (!resp?.status || !resp.data) return null;
    return resp.data;
  } catch {
    return null;
  }
}
