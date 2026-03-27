import AngelTokensModel from "../models/AngelTokens";
import UpstoxTokensModel from "../models/UpstoxTokens";
import InstrumentModel from "../models/Instrument";
import UpstoxInstrumentModel from "../models/UpstoxInstrument";
import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import { UpstoxAdapter } from "../adapters/UpstoxAdapter";
import { log } from "../utils/logger";

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
};

export async function placeOrderForClient(
  userId: string | unknown,
  clientcode: string,
  orderInput: PlaceOrderInput
) {
  // 1. Check AngelOne tokens
  const angelTokens = await AngelTokensModel.findOne({ userId, clientcode }).lean() as any;

  // 2. Check Upstox tokens if Angel fails or if clientcode looks like Upstox
  const upstoxTokens = !angelTokens?.jwtToken ? await UpstoxTokensModel.findOne({ userId }).lean() as any : null;

  if (!angelTokens?.jwtToken && !upstoxTokens?.accessToken) {
    throw new Error("No active broker session found for this user (Angel or Upstox)");
  }

  const txType = orderInput.side?.toUpperCase() as "BUY" | "SELL";
  if (txType !== "BUY" && txType !== "SELL") {
    throw new Error("Valid side (BUY/SELL) required");
  }

  // Case A: AngelOne
  if (angelTokens?.jwtToken) {
    const symbol = await InstrumentModel.findOne({
      tradingsymbol: orderInput.tradingsymbol,
      exchange: "NFO"
    });

    if (!symbol) {
      throw new Error("Option contract not found in DB (Angel)");
    }

    let finalQuantity = orderInput.quantity;

    const payload = {
      variety: "NORMAL",
      tradingsymbol: symbol.tradingsymbol,
      symboltoken: symbol.symboltoken,
      transactiontype: txType,
      exchange: "NFO",
      ordertype: orderInput.ordertype || "MARKET",
      producttype: "INTRADAY",
      duration: "DAY",
      price: orderInput.ordertype === "LIMIT" ? String(orderInput.price || 0) : "0",
      quantity: String(finalQuantity),
      squareoff: "0",
      stoploss: "0"
    };

    log.debug("Angel placeOrder payload:", payload);
    return await adapter.authPost(
      angelTokens.jwtToken,
      "/rest/secure/angelbroking/order/v1/placeOrder",
      payload
    );
  }

  // Case B: Upstox
  if (upstoxTokens?.accessToken) {
    const symbol = await UpstoxInstrumentModel.findOne({
      tradingsymbol: orderInput.tradingsymbol
    });

    if (!symbol) {
      throw new Error("Option contract not found in DB (Upstox)");
    }

    let finalQuantity = orderInput.quantity;

    const payload = {
      instrument_token: symbol.instrument_key,
      quantity: finalQuantity,
      order_type: orderInput.ordertype || "MARKET",
      transaction_type: txType,
      product: "I", // Intraday
      validity: "DAY",
      price: orderInput.ordertype === "LIMIT" ? (orderInput.price || 0) : 0,
      trigger_price: 0,
      disclosed_quantity: 0,
      is_amo: false,
      remark: "signal-order"
    };

    log.debug("Upstox placeOrder payload:", payload);
    const resp = await upstoxAdapter.placeOrder(upstoxTokens.accessToken, payload);
    return { status: true, data: resp.data }; // Match AngelOne response structure loosely
  }

  throw new Error("Execution failed: No valid broker flow matched");
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
