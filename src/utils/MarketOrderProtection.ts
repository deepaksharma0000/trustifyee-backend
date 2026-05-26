import log from "./logger";

export interface ProtectedOrderResult {
  ordertype: "LIMIT";
  price: string;
  originalType: string;
  slippagePercent: number;
  ltp: number;
}

export class MarketOrderProtection {
  // Configurable protection settings
  private static readonly DEFAULT_OPTION_SLIPPAGE = 0.02; // 2% slippage protection for NFO options
  private static readonly DEFAULT_EQUITY_SLIPPAGE = 0.01; // 1% slippage protection for Equity
  
  /**
   * Intercepts order requests and enforces limit price protection if a market order is requested.
   * Converts all MARKET orders in options/derivative segments (and optionally equities) to limit orders.
   * Also enforces IOC prevention.
   */
  public static async enforceProtection(
    orderInput: {
      exchange: string;
      tradingsymbol: string;
      side: "BUY" | "SELL";
      ordertype?: string;
      price?: number;
      symboltoken?: string;
      duration?: string;
    },
    decJwtToken: string,
    userApiKey: string
  ): Promise<ProtectedOrderResult> {
    const exchange = String(orderInput.exchange || "NFO").toUpperCase().trim();
    const tradingsymbol = String(orderInput.tradingsymbol || "").toUpperCase().trim();
    const side = String(orderInput.side || "BUY").toUpperCase().trim() as "BUY" | "SELL";
    const requestedType = String(orderInput.ordertype || "MARKET").toUpperCase().trim();
    const duration = String(orderInput.duration || "DAY").toUpperCase().trim();

    // 🛡️ 1. Prevent IOC (Immediate or Cancel) order duration leakage
    if (duration === "IOC") {
      log.warn(`[MARKET_PROTECTION] Rejected IOC order validity for ${tradingsymbol}. Converting to DAY compliance validity.`);
      orderInput.duration = "DAY";
    }

    // 🛡️ 2. Enforce Market Order Protection
    if (requestedType === "MARKET") {
      log.info(`[MARKET_PROTECTION] Intercepted raw MARKET order for ${exchange}:${tradingsymbol}. Enforcing SEBI/NSE compliance conversions...`);

      // Determine slippage budget based on exchange segment
      const isOption = exchange === "NFO" || exchange === "MCX" || exchange === "CDS";
      const slippagePercent = isOption ? this.DEFAULT_OPTION_SLIPPAGE : this.DEFAULT_EQUITY_SLIPPAGE;

      // Fetch absolute latest LTP just-in-time from Universal Market Data Service
      let ltp = 0;
      try {
        const { getInstrumentLtp } = require("../services/MarketDataService");
        ltp = await getInstrumentLtp(exchange, tradingsymbol, orderInput.symboltoken || "");
      } catch (err: any) {
        log.error(`[MARKET_PROTECTION] Failed to fetch live LTP for price protection validation: ${err.message}`);
        throw new Error(`MARKET_ORDER_PROTECTION_ERROR: Unable to verify live LTP for safety check on ${exchange}:${tradingsymbol}`);
      }

      if (ltp <= 0) {
        throw new Error(`MARKET_ORDER_PROTECTION_ERROR: Invalid or zero LTP returned from broker for ${exchange}:${tradingsymbol}`);
      }

      // Calculate safe price bounds
      let protectedPrice = 0;
      if (side === "BUY") {
        // Buy Limit is placed slightly above the Ask to guarantee execution up to the slippage boundary
        protectedPrice = ltp * (1 + slippagePercent);
      } else {
        // Sell Limit is placed slightly below the Bid to guarantee execution down to the slippage boundary
        protectedPrice = ltp * (1 - slippagePercent);
      }

      // Align calculated price with exchange tick size (0.05 paisa)
      protectedPrice = Math.round(protectedPrice * 20) / 20;

      log.info(`[MARKET_PROTECTION] Successfully converted raw MARKET order to Protected LIMIT order. LTP: ${ltp}, Protection Slip: ${slippagePercent * 100}%, Calculated Limit Price: ${protectedPrice}`);

      return {
        ordertype: "LIMIT",
        price: protectedPrice.toFixed(2),
        originalType: "MARKET",
        slippagePercent,
        ltp,
      };
    }

    // 🛡️ 3. For existing limit orders, verify they have limit price protection (not raw zero prices)
    if (requestedType === "LIMIT") {
      const currentPrice = Number(orderInput.price || 0);
      if (currentPrice <= 0) {
        throw new Error(`MARKET_ORDER_PROTECTION_ERROR: Encountered LIMIT order with zero or negative price for ${tradingsymbol}.`);
      }
    }

    return {
      ordertype: "LIMIT",
      price: String(orderInput.price || "0"),
      originalType: requestedType,
      slippagePercent: 0,
      ltp: Number(orderInput.price || 0),
    };
  }
}
