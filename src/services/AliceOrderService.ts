// src/services/AliceOrderService.ts
import AliceTokensModel from "../models/AliceTokens";
import { AliceBlueAdapter } from "../adapters/AliceBlueAdapter";
import AliceInstrumentModel, { IAliceInstrument } from "../models/AliceInstrument";
import { log } from "../utils/logger";

const adapter = new AliceBlueAdapter();

export type AlicePlaceOrderInput = {
  exchange: string;
  tradingsymbol: string;
  side?: "BUY" | "SELL";
  transactiontype?: "BUY" | "SELL";
  quantity: number;
  ordertype?: "MARKET" | "LIMIT";
  price?: number;
  producttype?: string;
  duration?: string;
  symboltoken?: string;
  triggerPrice?: number;
};

async function findAliceSymbol(
  exchange: string,
  tradingSymbol: string
): Promise<{ exchange: string; tradingsymbol: string; symboltoken: string }> {
  const doc = await AliceInstrumentModel.findOne({
    exchange: exchange.toUpperCase(),
    tradingSymbol: tradingSymbol
  }).lean<IAliceInstrument>();   // 🔹 yaha type fix

  if (!doc) {
    throw new Error(
      `Alice: Instrument not found in DB for ${exchange} ${tradingSymbol}`
    );
  }

  return {
    exchange: doc.exchange,
    tradingsymbol: doc.tradingSymbol,
    symboltoken: doc.token
  };
}


export async function placeAliceOrderForClient(
  clientcode: string,
  orderInput: AlicePlaceOrderInput
) {
  const tokens = await AliceTokensModel.findOne({ clientcode });
  if (!tokens?.sessionId) {
    throw new Error("No active Alice session for clientcode");
  }

  // Agar client ne symboltoken directly nahi diya to DB se nikaalo
  let symbol: { exchange: string; tradingsymbol: string; symboltoken: string };

  if (orderInput.symboltoken) {
    symbol = {
      exchange: orderInput.exchange.toUpperCase(),
      tradingsymbol: orderInput.tradingsymbol,
      symboltoken: orderInput.symboltoken
    };
  } else {
    symbol = await findAliceSymbol(orderInput.exchange, orderInput.tradingsymbol);
  }

  log.debug("Alice Matched Symbol (Alice DB):", symbol);

  const rawTxType = orderInput.transactiontype || orderInput.side;
  const txType = rawTxType?.toString().toUpperCase();

  if (txType !== "BUY" && txType !== "SELL") {
    throw new Error(`Invalid Alice side/transactiontype: ${rawTxType}`);
  }

  const txTypeNarrow = txType as "BUY" | "SELL";

  const payload = {
    exchange: symbol.exchange,               // "NFO"
    tradingsymbol: symbol.tradingsymbol,     // "ZYDUSLIFE24FEB26C1120"
    symboltoken: symbol.symboltoken,         // "154929"
    transactiontype: txTypeNarrow,
    ordertype: orderInput.ordertype || "MARKET",
    producttype: orderInput.producttype || "INTRADAY",
    duration: orderInput.duration || "DAY",
    price: orderInput.price ?? 0,
    quantity: orderInput.quantity || 1,
    triggerPrice: orderInput.triggerPrice
  };

  log.debug("Alice placeOrder payload:", payload);

  try {
    const resp = await adapter.placeOrder(tokens.sessionId, payload);
    return resp;
  } catch (err: any) {
    log.error("placeAliceOrderForClient failed:", err.message || err);
    throw err;
  }
}


export async function getAliceOrderStatusForClient(
  clientcode: string,
  orderId: string
) {
  const tokens = await AliceTokensModel.findOne({ clientcode });
  if (!tokens?.sessionId) {
    throw new Error("No active Alice session for clientcode");
  }

  return await adapter.getOrderStatus(tokens.sessionId, orderId);
}
