// src/services/PaperTradingSimulator.ts
import { eventSourcedOMS } from "./EventSourcedOMS";
import log from "../utils/logger";

export interface PaperOrder {
  clientOrderId: string;
  tradingsymbol: string;
  exchange: string;
  side: "BUY" | "SELL";
  quantity: number;
  ordertype: "MARKET" | "LIMIT";
  price?: number;
  status: "SUBMITTED" | "FILLED" | "PARTIALLY_FILLED" | "CANCELLED" | "REJECTED";
  executedQty: number;
  remainingQty: number;
  avgPrice: number;
  createdAt: number;
}

export class PaperTradingSimulator {
  private static instance: PaperTradingSimulator;

  private paperOrderBook = new Map<string, PaperOrder>(); // clientOrderId -> PaperOrder

  // Simulation parameters
  private readonly DEFAULT_LATENCY_DELAY_MS = 80; // 80ms baseline network delay
  private readonly SLIPPAGE_FACTOR = 0.0005;      // 0.05% slippage on market orders

  private constructor() {}

  public static getInstance(): PaperTradingSimulator {
    if (!PaperTradingSimulator.instance) {
      PaperTradingSimulator.instance = new PaperTradingSimulator();
    }
    return PaperTradingSimulator.instance;
  }

  /**
   * Deterministic paper order execution handler.
   * Simulates network transport latency, slippage spreads, and delayed split fills.
   */
  public async submitOrder(payload: {
    clientOrderId: string;
    tradingsymbol: string;
    exchange: string;
    side: "BUY" | "SELL";
    quantity: number;
    ordertype: "MARKET" | "LIMIT";
    price?: number;
  }): Promise<void> {
    log.info(`[PaperSimulator] Received placement request for ${payload.clientOrderId}. Simulating transport latency...`);

    // 1. Simulate network transit delay
    await new Promise((resolve) => setTimeout(resolve, this.DEFAULT_LATENCY_DELAY_MS));

    const order: PaperOrder = {
      ...payload,
      status: "SUBMITTED",
      executedQty: 0,
      remainingQty: payload.quantity,
      avgPrice: payload.price || 0,
      createdAt: Date.now(),
    };

    this.paperOrderBook.set(payload.clientOrderId, order);

    // Emit acknowledgment to EventSourcedOMS
    await eventSourcedOMS.appendEvent(
      payload.clientOrderId,
      `PAPER_${payload.clientOrderId}`,
      "ACKNOWLEDGED",
      { brokerOrderId: `PAPER_${payload.clientOrderId}` }
    );

    // Trigger asynchronous execution loop (simulating market match)
    this.processExecutionMatch(payload.clientOrderId);
  }

  private async processExecutionMatch(clientOrderId: string) {
    const order = this.paperOrderBook.get(clientOrderId);
    if (!order || order.status !== "SUBMITTED") return;

    // Simulate match matching engine latency
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Determine fill style (highly volatile options often split fills)
    const splitChance = Math.random();
    
    if (splitChance < 0.2 && order.quantity > 50) {
      // 1. Simulate Split Partial Fill
      const partialQty = Math.floor(order.quantity / 2);
      order.status = "PARTIALLY_FILLED";
      order.executedQty = partialQty;
      order.remainingQty = order.quantity - partialQty;
      
      const priceWithSlippage = this.applyMarketSlippage(order.price || 100, order.side);
      order.avgPrice = priceWithSlippage;

      log.warn(`[PaperSimulator] Split execution triggered for ${clientOrderId}. Partial Fill Qty: ${partialQty}`);

      await eventSourcedOMS.appendEvent(
        clientOrderId,
        `PAPER_${clientOrderId}`,
        "PARTIALLY_FILLED",
        {
          filledQty: partialQty,
          remainingQty: order.remainingQty,
          avgPrice: priceWithSlippage,
        }
      );

      // Schedule remainder fill
      setTimeout(async () => {
        order.status = "FILLED";
        order.executedQty = order.quantity;
        order.remainingQty = 0;

        await eventSourcedOMS.appendEvent(
          clientOrderId,
          `PAPER_${clientOrderId}`,
          "FILLED",
          {
            filledQty: order.quantity,
            remainingQty: 0,
            avgPrice: priceWithSlippage,
          }
        );
      }, 200);

    } else {
      // 2. Simulate Immediate Single Full Fill
      order.status = "FILLED";
      order.executedQty = order.quantity;
      order.remainingQty = 0;

      const priceWithSlippage = this.applyMarketSlippage(order.price || 100, order.side);
      order.avgPrice = priceWithSlippage;

      await eventSourcedOMS.appendEvent(
        clientOrderId,
        `PAPER_${clientOrderId}`,
        "FILLED",
        {
          filledQty: order.quantity,
          remainingQty: 0,
          avgPrice: priceWithSlippage,
        }
      );
    }
  }

  private applyMarketSlippage(price: number, side: "BUY" | "SELL"): number {
    const slippageAmt = price * this.SLIPPAGE_FACTOR;
    return side === "BUY" ? price + slippageAmt : price - slippageAmt;
  }
}

export const paperTradingSimulator = PaperTradingSimulator.getInstance();
