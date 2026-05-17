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
};

function resolveNetworkRouting(orderInput: PlaceOrderInput, user: any) {
  const localBindingEnabled = process.env.ANGEL_ENABLE_LOCAL_BINDING === "true";
  const fromPayloadIp = typeof orderInput.outgoingIp === "string" ? orderInput.outgoingIp.trim() : "";
  const fromProfileIp = typeof user?.outgoing_ip === "string" ? String(user.outgoing_ip).trim() : "";
  const fromPayloadAgent = typeof orderInput.agentUrl === "string" ? orderInput.agentUrl.trim() : "";
  const fromProfileAgent = typeof user?.agent_url === "string" ? String(user.agent_url).trim() : "";
  const dedicatedFromProfile = Boolean(user?.dedicated_ip_enabled === true);
  const dedicatedFromPayload = Boolean((orderInput as any)?.dedicatedIpEnabled === true);
  const dedicatedImplicit = Boolean(fromPayloadIp || fromProfileIp || fromPayloadAgent || fromProfileAgent);
  const dedicatedRoutingEnabled = dedicatedFromPayload || dedicatedFromProfile || dedicatedImplicit;

  if (config.forceSharedVpsRoute && !dedicatedRoutingEnabled) {
    if (fromPayloadIp || fromProfileIp || fromPayloadAgent || fromProfileAgent) {
      log.debug("[ORDER_NETWORK] FORCE_SHARED_VPS_ROUTE active. Ignoring user-level outgoing_ip/agent_url.");
    }
    return {
      outgoingIp: "",
      agentUrl: "",
      usingServerNetworkFallback: true,
      dedicatedRoutingEnabled: false,
    };
  }

  const outgoingIp = fromPayloadIp || fromProfileIp || "";
  const agentUrl = fromPayloadAgent || fromProfileAgent || "";

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

  log.debug(`[OrderService] Attempting order for ${clientcode}. Current Failures: ${user!.consecutive_failures || 0}`);


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
  try {
      // 1. Run Validations
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
      const userApiKey = await ensureEncrypted(angelTokens, 'apiKey', `user_${userId}_order_placement`);
      
      if (!userApiKey || userApiKey.length < 5) {
          log.error(`[ORDER_BLOCKED_INVALID_STATE] Invalid API Key for ${clientcode}`);
          throw new Error("Invalid or missing API key. Please update your broker settings.");
      }
      if (!decJwtToken || decJwtToken.length < 20) {
          log.error(`[ORDER_BLOCKED_INVALID_STATE] Invalid session token for ${clientcode}`);
          throw new Error("Invalid session. Please login to your broker again.");
      }

      // 🚀 [FIX 2] Pass outgoingIp and agentUrl to AngelOneAdapter
      const dynamicAdapter = getOrCreateAngelAdapter(userApiKey, {
        outgoingIp: currentIp,
        agentUrl: currentAgentUrl,
      });

      orderInput.symboltoken = await resolveOrderSymbolToken(orderInput);

      // 3. Place Order
      const txType = orderInput.side?.toUpperCase() as "BUY" | "SELL";
      const payload = {
        variety: "NORMAL",
        tradingsymbol: orderInput.tradingsymbol,
        symboltoken: orderInput.symboltoken,
        transactiontype: txType,
        exchange: orderInput.exchange || "NFO",
        ordertype: orderInput.ordertype || "MARKET",
        producttype: orderInput.producttype || "INTRADAY",
        duration: "DAY",
        price: orderInput.ordertype === "LIMIT" ? String(orderInput.price || 0) : "0",
        quantity: String(orderInput.quantity),
        squareoff: "0",
        stoploss: "0"
      };

      // Use dynamic adapter instance with the correct API key and optional agent
      const resp = await dynamicAdapter.placeOrder(
        decJwtToken,
        payload
      );

      const brokerData = resp?.data || {};
      const brokerCode = String(brokerData?.errorCode || brokerData?.errorcode || "").toUpperCase();
      const brokerMessage = String(brokerData?.message || "");
      const brokerSuccess = brokerData?.status === true || brokerData?.success === true;
      const isInvalidTokenPayload = brokerCode === "AG8001" || brokerMessage.toLowerCase().includes("invalid token");

      if (isInvalidTokenPayload) {
          throw new Error(`AG8001 Invalid Token: ${brokerMessage || "Token expired"}`);
      }

      // Reset failures on success
      if (resp && resp.status === 200 && (brokerSuccess || brokerData?.data?.orderid || brokerData?.orderid)) {
          // [ISSUE 2 FIX] Atomic reset in DB + In-memory update
          await User.updateOne({ _id: userId }, { $set: { consecutive_failures: 0, trading_paused: false } });
          if (user) {
              user.consecutive_failures = 0;
              user.trading_paused = false;
          }
          log.info(`PLACE_ORDER_BROKER_SUCCESS: ${clientcode} - ${orderInput.tradingsymbol}`);
          return resp;
      } else {
          throw new Error(brokerMessage || resp?.data?.message || "Broker rejected order");
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
      
      if (isInvalidToken && retryCount < 1) {
          log.info(`[OrderService] Token expired for ${clientcode}. Attempting auto-refresh...`);
          const refreshed = await attemptTokenRefresh(userId, clientcode);
          if (refreshed) {
              log.info(`[OrderService] Token refreshed successfully for ${clientcode}. Retrying order...`);
              return placeOrderForClient(userId, clientcode, orderInput, retryCount + 1);
          }
      }

      // Generic Retry Logic (Only for Angel One)
      if (retryCount < 1 && !isInvalidToken) { 
          return placeOrderForClient(userId, clientcode, orderInput, retryCount + 1);
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
    if (!angelTokens.apiKey) throw new Error("User API Key missing in session");
    const userApiKey = decrypt(angelTokens.apiKey, `user_${userId}_status_check`);
    const dynamicAdapter = getOrCreateAngelAdapter(userApiKey, { outgoingIp });
    const orderBookResp = await dynamicAdapter.getOrderBook(angelTokens.jwtToken);
    if (orderBookResp && orderBookResp.status === 200 && Array.isArray(orderBookResp.data)) {
      // 1. Try exact Match
      let order = orderBookResp.data.find((o: any) => o.orderid === orderId);
      
      // 2. Try Fuzzy Match if ID is synthetic (BROKER-uuid)
      if (!order && orderId.startsWith("BROKER-") && symbolMatch) {
          log.info(`Fuzzy matching orderbook for ${symbolMatch} (synthetic ID: ${orderId})`);
          // Find most recent order with matching symbol
          order = orderBookResp.data.reverse().find((o: any) => 
            o.tradingsymbol === symbolMatch && 
            (o.orderstatus === "COMPLETE" || o.orderstatus === "OPEN")
          );
      }

      if (order) return { status: true, data: order };
    }
    
    // If exact ID lookup is possible (not our UUID)
    if (!orderId.startsWith("BROKER-")) {
        // Reuse dynamicAdapter created above (it's in scope if we refactor slightly, but for now just use the one we have or create new)
        return await dynamicAdapter.getOrderStatus(angelTokens.jwtToken, orderId);
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
  outgoingIp?: string
) {
  try {
    const resp = await getOrderStatusForClient(userId, clientcode, clientOrderId, outgoingIp);
    if (!resp?.status || !resp.data) return null;
    return resp.data;
  } catch {
    return null;
  }
}
