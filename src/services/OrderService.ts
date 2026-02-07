import AngelTokensModel from "../models/AngelTokens";
import InstrumentModel from "../models/Instrument";
import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import { log } from "../utils/logger";

const adapter = new AngelOneAdapter();

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
  clientcode: string,
  orderInput: PlaceOrderInput
) {
  // STEP 0 - Client token
  const tokens = await AngelTokensModel.findOne({ clientcode });
  if (!tokens?.jwtToken) {
    throw new Error("No active session for clientcode");
  }

  // STEP 1 - BUY / SELL validate
  const txType = orderInput.side?.toUpperCase();
  if (txType !== "BUY" && txType !== "SELL") {
    throw new Error("Valid side (BUY/SELL) required");
  }

  // STEP 2 - Resolve option contract from DB
  const symbol = await InstrumentModel.findOne({
    tradingsymbol: orderInput.tradingsymbol,
    exchange: "NFO"
  });

  if (!symbol) {
    throw new Error("Option contract not found in DB");
  }

// new block 
// let finalQuantity = orderInput.quantity;

// // 🔥 NIFTY option trade → LOT based
// if (
//   symbol.instrumenttype === "OPTIDX" &&
//   symbol.name === "NIFTY"
// ) {
//   const lotSize = symbol.lotSize || 65;

//   const lots = Number(orderInput.quantity);
//   if (!lots || lots <= 0) {
//     throw new Error("Invalid lot count");
//   }

//   finalQuantity = lots * lotSize; // 🔥 MAGIC LINE
// }
// 🔥 LOT BASED QUANTITY FIX (NIFTY / BANKNIFTY)
let finalQuantity = orderInput.quantity;

if (
  symbol.instrumenttype === "OPTIDX" &&
  (symbol.name === "NIFTY" || symbol.name === "BANKNIFTY" || symbol.name === "FINNIFTY")
) {
  if (!symbol.lotSize) {
    throw new Error("Lot size not found for index option");
  }

  finalQuantity = orderInput.quantity * symbol.lotSize;
}




  // STEP 3 - Angel payload
  const payload = {
    variety: "NORMAL",
    tradingsymbol: symbol.tradingsymbol,
    symboltoken: symbol.symboltoken,
    transactiontype: txType,
    exchange: "NFO",
    ordertype: orderInput.ordertype || "MARKET",
    producttype: "INTRADAY",
    duration: "DAY",
    price: "0",
    // quantity: String(orderInput.quantity),
    // quantity: String(finalQuantity),
    quantity: String(finalQuantity),
    squareoff: "0",
    stoploss: "0"
  };

  log.debug("Angel placeOrder payload:", payload);

  // STEP 4 - Place order
  return await adapter.authPost(
    tokens.jwtToken,
    "/rest/secure/angelbroking/order/v1/placeOrder",
    payload
  );
}
export async function getOrderStatusForClient(
  clientcode: string,
  orderId: string
) {
  const tokens = await AngelTokensModel.findOne({ clientcode });
  if (!tokens?.jwtToken) {
    throw new Error("No active session for clientcode");
  }

  return await adapter.getOrderStatus(tokens.jwtToken, orderId);
}

