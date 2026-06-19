// src/services/AliceOrderService.ts
import { AliceBlueAdapter } from "../adapters/AliceBlueAdapter";
import log from "../utils/logger";
import {
  findAliceTokensForClient,
  markAliceSessionExpired,
  normalizeAliceClientCode,
} from "./AliceSessionService";
import { parseAliceOrderPlacement } from "../utils/aliceResponseParser";
import { resolveAliceInstrument } from "../utils/aliceInstrumentResolver";

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
  outgoingIp?: string;
  userId?: string;
};

export async function placeAliceOrderForClient(
  clientcode: string,
  orderInput: AlicePlaceOrderInput
) {
  const normalizedCode = normalizeAliceClientCode(clientcode);
  const tokens = await findAliceTokensForClient(normalizedCode, orderInput.userId);
  if (!tokens?.sessionId) {
    throw new Error(
      `No active Alice Blue session for client ${normalizedCode}. User must reconnect broker.`
    );
  }

  const resolution = await resolveAliceInstrument(
    orderInput.exchange,
    orderInput.tradingsymbol,
    orderInput.symboltoken
  );

  if (!resolution.found) {
    throw new Error(
      `Alice: Instrument not found for ${orderInput.exchange} ${orderInput.tradingsymbol}. Run NFO instrument sync.`
    );
  }

  const activeAdapter = orderInput.outgoingIp ? new AliceBlueAdapter(orderInput.outgoingIp) : adapter;

  const rawTxType = orderInput.transactiontype || orderInput.side;
  const txType = rawTxType?.toString().toUpperCase();

  if (txType !== "BUY" && txType !== "SELL") {
    throw new Error(`Invalid Alice side/transactiontype: ${rawTxType}`);
  }

  const payload = {
    exchange: resolution.exchange,
    tradingsymbol: resolution.tradingsymbol,
    symboltoken: resolution.symboltoken,
    transactiontype: txType as "BUY" | "SELL",
    ordertype: (orderInput.ordertype || "MARKET") as "MARKET" | "LIMIT",
    producttype: orderInput.producttype || "INTRADAY",
    duration: orderInput.duration || "DAY",
    price: orderInput.price ?? 0,
    quantity: orderInput.quantity || 1,
    triggerPrice: orderInput.triggerPrice,
  };

  log.info("[AliceOrderService] placeOrder", {
    clientcode: normalizedCode,
    tradingsymbol: payload.tradingsymbol,
    instrumentId: payload.symboltoken,
    quantity: payload.quantity,
    resolutionSource: resolution.source,
  });

  try {
    const resp = await activeAdapter.placeOrder(tokens.sessionId, payload);
    const parsed = parseAliceOrderPlacement(resp);
    if (!parsed.accepted) {
      throw new Error(parsed.rejectionReason || parsed.brokerMessage || "Alice Blue rejected order");
    }
    return resp;
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (/session|unauthorized|invalid token|auth/i.test(msg)) {
      await markAliceSessionExpired(normalizedCode, orderInput.userId);
    }
    log.error("placeAliceOrderForClient failed:", msg);
    throw err;
  }
}

export async function getAliceOrderStatusForClient(
  clientcode: string,
  orderId: string,
  symbolMatch?: string,
  userId?: string
) {
  const normalizedCode = normalizeAliceClientCode(clientcode);
  const tokens = await findAliceTokensForClient(normalizedCode, userId);
  if (!tokens?.sessionId) {
    throw new Error("No active Alice session for clientcode");
  }

  return await adapter.getOrderStatus(tokens.sessionId, orderId, symbolMatch);
}

export { parseAliceOrderPlacement };
