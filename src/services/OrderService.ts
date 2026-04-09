import AngelTokensModel from "../models/AngelTokens";
import UpstoxTokensModel from "../models/UpstoxTokens";
import InstrumentModel from "../models/Instrument";
import UpstoxInstrumentModel from "../models/UpstoxInstrument";
import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import { UpstoxAdapter } from "../adapters/UpstoxAdapter";
import { log } from "../utils/logger";
import { ProfileValidationService } from "./ProfileValidationService";
import { RiskManagementService } from "./RiskManagementService";
import User from "../models/User";

const adapter = new AngelOneAdapter();
const upstoxAdapter = new UpstoxAdapter();

export type PlaceOrderInput = {
  exchange: string;
  tradingsymbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  ordertype?: "MARKET" | "LIMIT";
  transactiontype: "BUY" | "SELL";
  price?: number;
  producttype?: "INTRADAY" | "DELIVERY";
  duration?: "DAY" | "IOC";
  symboltoken?: string;
  triggerPrice?: number;
  // For dynamic sizing
  isDynamicQty?: boolean;
  riskPercent?: number;
};

/**
 * Robust Pre-Trade Validation Wrapper
 */
async function runPreTradeValidation(userId: string, clientcode: string, orderInput: PlaceOrderInput) {
  // 1. Profile Validation (Includes NFO permission check)
  const profileRes = await ProfileValidationService.validateUserSession(userId, clientcode);
  if (!profileRes.status) return profileRes;

  // 2. Risk Management (Margin Check)
  const marginRes = await RiskManagementService.getAvailableMargin(userId, clientcode);
  if (!marginRes.status || !marginRes.data) return marginRes;

  // 3. Dynamic Quantity Calculation if requested
  if (orderInput.isDynamicQty && orderInput.riskPercent) {
      // We need LTP for calculation
      try {
          const tokens = await AngelTokensModel.findOne({ userId, clientcode }).lean() as any;
          const ltpRes = await adapter.getLtp(tokens.jwtToken, orderInput.exchange || "NFO", orderInput.tradingsymbol, orderInput.symboltoken || "");
          const ltp = Number(ltpRes?.data?.ltp || 0);
          
          const instrument = await InstrumentModel.findOne({ tradingsymbol: orderInput.tradingsymbol, exchange: orderInput.exchange || "NFO" }).lean() as any;
          const lotSize = instrument?.lotSize || 1;

          if (ltp > 0) {
              const newQty = RiskManagementService.calculateDynamicQuantity(marginRes.data.availablecash, orderInput.riskPercent, ltp, lotSize);
              log.info(`DYNAMIC_SIZE: Recalculated Qty ${orderInput.quantity} -> ${newQty} for ${clientcode}`);
              orderInput.quantity = newQty;
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
  if (requiredAmount > 0 && !RiskManagementService.checkMarginSufficient(marginRes.data.totalusablemargin, requiredAmount)) {
      log.error(`TRADE_BLOCKED: Insufficient usable margin for ${clientcode}. Required: ${requiredAmount}`);
      return { status: false, message: "MARGIN_INSUFFICIENT" };
  }

  return { status: true };
}

export async function placeOrderForClient(
  userId: any,
  clientcode: string,
  orderInput: PlaceOrderInput,
  retryCount = 0
): Promise<any> {
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");

  if (user.trading_paused) {
      log.warn(`TRADE_BLOCKED: Trading is paused for ${user.user_name} due to consecutive failures.`);
      return { status: false, message: "TRADING_PAUSED_BY_SYSTEM" };
  }

  try {
      // 1. Run Validations
      const validation = await runPreTradeValidation(user._id.toString(), clientcode, orderInput);
      if (!validation.status) {
          throw new Error(validation.message || "Validation failed");
      }

      // 2. Fetch tokens
      const angelTokens = await AngelTokensModel.findOne({ userId, clientcode }).lean() as any;
      if (!angelTokens?.jwtToken) throw new Error("No Angel session");

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

      const resp = await adapter.authPost(
        angelTokens.jwtToken,
        "/rest/secure/angelbroking/order/v1/placeOrder",
        payload
      );

      // Reset failures on success
      if (resp && resp.status === true) {
          user.consecutive_failures = 0;
          await user.save();
          log.info(`PLACE_ORDER_BROKER_SUCCESS: ${clientcode} - ${orderInput.tradingsymbol}`);
          return resp;
      } else {
          throw new Error(resp?.message || "Broker rejected order");
      }

  } catch (err: any) {
      log.error(`ORDER_FAILURE [Attempt ${retryCount + 1}]: ${clientcode} - ${err.message}`);

      // Retry Logic
      if (retryCount < 1) { // Retry max 2 times total
          return placeOrderForClient(userId, clientcode, orderInput, retryCount + 1);
      }

      // Circuit Breaker logic
      user.consecutive_failures = (user.consecutive_failures || 0) + 1;
      if (user.consecutive_failures >= 3) {
          user.trading_paused = true;
          log.error(`CIRCUIT_BREAKER_TRIGGERED: Pausing trading for ${user.user_name}`);
      }
      await user.save();

      return { status: false, message: err.message };
  }
}

export async function getOrderStatusForClient(
  userId: string | unknown,
  clientcode: string,
  orderId: string,
  symbolMatch?: string // Optional: Find by symbol if orderId is synthetic
) {
  const angelTokens = await AngelTokensModel.findOne({ userId, clientcode }).lean() as any;
  if (angelTokens?.jwtToken) {
    const orderBookResp = await adapter.getOrderBook(angelTokens.jwtToken);
    if (orderBookResp && orderBookResp.status && Array.isArray(orderBookResp.data)) {
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
        return await adapter.getOrderStatus(angelTokens.jwtToken, orderId);
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
