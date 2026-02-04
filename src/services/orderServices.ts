import { OptionContract } from "../models/OptionContract";
import { placeUpstoxOrder } from "../clients/upstoxClient";
import {
  selectOptionInstrument,
  OptionSelectionParams,
} from "./optionChainService";

export async function placeOptionOrder(
  instrument_key: string,
  lots: number,
  side: "BUY" | "SELL",
  type: "MARKET" | "LIMIT",
  price?: number,
  accessToken?: string
) {
  if (!instrument_key || typeof instrument_key !== "string") {
    throw new Error("instrument_key is required and must be a string");
  }

  const key = instrument_key.trim();

  const contract = await OptionContract.findOne({ instrument_key: key });

  if (!contract) {
    throw new Error(`Instrument not found in DB: ${key}`);
  }

  if (!contract.lot_size || contract.lot_size <= 0) {
    throw new Error(`Invalid lot_size for ${key}`);
  }

  const quantity = contract.lot_size * lots;

  // 🚀 Correct Upstox payload (NO camelCase)
  // const orderPayload = {
  // instrument_token: Number(contract.exchange_token),
  //   quantity,
  //   order_type: type,               // MARKET | LIMIT
  //   transaction_type: side,         // BUY | SELL
  //   product: "I",
  //   validity: "DAY",
  //   price: type === "LIMIT" ? price ?? 0 : 0,
  //   trigger_price: 0,
  //   disclosed_quantity: 0,
  //   remark: "order",
  // };
  // ✅ FIX: use instrument_key (string) as instrument_token
  const orderPayload = {
    instrument_token: contract.instrument_key,  // e.g. "NSE_FO|36365"
    quantity,
    order_type: type,               // "MARKET" | "LIMIT"
    transaction_type: side,         // "BUY" | "SELL"
    product: "I",                   // Intraday (I / D / MTF allowed) :contentReference[oaicite:2]{index=2}
    validity: "DAY",
    price: type === "LIMIT" ? (price ?? 0) : 0,
    trigger_price: 0,
    disclosed_quantity: 0,
    is_amo: false,
    remark: "order",
  };
  console.log("DEBUG OPTION CONTRACT:", contract.toObject());
  console.log("DEBUG ORDER PAYLOAD:", orderPayload);

  // Validate limit order
  if (type === "LIMIT" && (!price || price <= 0)) {
    throw new Error("Limit order requires valid price > 0");
  }

  const response = await placeUpstoxOrder(orderPayload, accessToken);

  return {
    message: "Order Placed Successfully",
    request: orderPayload,
    serverResponse: response,
  };
}
/**
 * High-level algo order:
 *  - find right contract from option chain (DB)
 *  - calculate quantity from lot_size * lots
 *  - place order via Upstox
 */
export async function placeAlgoOptionOrder(params: {
  underlyingSymbol: string; // e.g. "NIFTY"
  ltp: number; // current NIFTY price
  side: "BUY" | "SELL"; // BUY / SELL
  optionSide: "CE" | "PE"; // CE / PE
  type: "MARKET" | "LIMIT";
  lots: number;
  strikesAway?: number; // 0 = pure ATM, +1 OTM, -1 ITM
  expiryMode?: "NEAREST" | "NEXT";
  price?: number; // for LIMIT orders
  accessToken?: string;
}) {
  const {
    underlyingSymbol,
    ltp,
    side,
    optionSide,
    type,
    lots,
    strikesAway = 0,
    expiryMode = "NEAREST",
    price,
    accessToken,
  } = params;

  if (lots <= 0) {
    throw new Error("lots must be > 0");
  }

  // 1) select instrument from chain
  const instrument = await selectOptionInstrument({
    underlyingSymbol,
    ltp,
    side: optionSide,
    strikesAway,
    expiryMode,
  });

  if (!instrument) {
    throw new Error("No suitable option instrument found for selection params");
  }

  if (!instrument.lot_size || instrument.lot_size <= 0) {
    throw new Error(
      `Invalid lot_size for instrument ${instrument.instrument_key}`
    );
  }

  const quantity = instrument.lot_size * lots;

  const orderPayload = {
    instrument_token: instrument.instrument_key, // Upstox uses instrument_key
    quantity,
    order_type: type,
    transaction_type: side,
    product: "I",
    validity: "DAY",
    price: type === "LIMIT" ? price ?? 0 : 0,
    trigger_price: 0,
    disclosed_quantity: 0,
    is_amo: false,
    remark: "algo-order",
  };

  if (type === "LIMIT" && (!price || price <= 0)) {
    throw new Error("Limit order requires valid price > 0");
  }

  const response = await placeUpstoxOrder(orderPayload, accessToken);

  return {
    message: "Algo order placed",
    instrument: {
      instrument_key: instrument.instrument_key,
      tradingsymbol: instrument.tradingsymbol,
      expiry: instrument.expiry,
      strike: instrument.strike_price,
      option_type: instrument.option_type,
    },
    request: orderPayload,
    serverResponse: response,
  };
}
