// src/services/AliceOrderService.ts
import AliceTokensModel from "../models/AliceTokens";
import { AliceBlueAdapter } from "../adapters/AliceBlueAdapter";
import AliceInstrumentModel, { IAliceInstrument } from "../models/AliceInstrument";
import log from "../utils/logger";
import InstrumentModel from "../models/Instrument";

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
  outgoingIp?: string; // [NEW]
};

async function findAliceSymbol(
  exchange: string,
  tradingSymbol: string
): Promise<{ exchange: string; tradingsymbol: string; symboltoken: string }> {
  const exchangeUpper = exchange.toUpperCase();
  
  // 1. Direct Match Attempt
  let doc = await AliceInstrumentModel.findOne({
    exchange: exchangeUpper,
    tradingSymbol: tradingSymbol
  }).lean<IAliceInstrument>();

  // 2. Cross-Broker Metadata Match (If direct match fails, common for F&O)
  if (!doc) {
    log.info(`Alice: Direct match failed for ${tradingSymbol}. Attempting metadata match...`);
    
    // Find the original instrument info (likely AngelOne based)
    const original = await InstrumentModel.findOne({
      exchange: exchangeUpper,
      tradingsymbol: tradingSymbol
    }).lean();

    if (original && original.strike && original.expiry) {
      log.info(`Alice: Attempting metadata match for ${original.name} ${original.strike} ${original.optiontype} ${original.expiry}`);
      
      const expDate = new Date(original.expiry);
      const startOfDay = new Date(expDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(expDate);
      endOfDay.setHours(23, 59, 59, 999);

      // Find Alice equivalent using Strike, Expiry, and OptionType
      doc = await AliceInstrumentModel.findOne({
        exchange: exchangeUpper,
        symbol: original.name || original.tradingsymbol.replace(/[0-9].*$/, ""), 
        strikePrice: original.strike,
        optionType: original.optiontype,
        expiry: { $gte: startOfDay, $lt: endOfDay }
      }).lean<IAliceInstrument>();

      if (doc) {
        log.info(`Alice: Metadata match success! Found ${doc.tradingSymbol} for ${tradingSymbol}`);
      }
    }
  }

  if (!doc) {
    throw new Error(
      `Alice: Instrument not found in DB for ${exchange} ${tradingSymbol}. Please sync Alice instruments.`
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

  // 🚀 [ROBUST SYMBOL RESOLUTION]
  const symbol = await findAliceSymbol(orderInput.exchange, orderInput.tradingsymbol);
  
  // 🛡️ [IP BINDING]
  // Create a fresh adapter instance if outgoingIp is provided
  const activeAdapter = orderInput.outgoingIp ? new AliceBlueAdapter(orderInput.outgoingIp) : adapter;

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
    const resp = await activeAdapter.placeOrder(tokens.sessionId, payload);
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
