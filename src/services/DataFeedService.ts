import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import { config } from "../config";
import log from "../utils/logger";
import speakeasy from "speakeasy";

/**
 * 💹 [DATA LAYER] Dedicated Data Feed Service
 * Uses a single dedicated broker account for all market data needs.
 * Ensures strict isolation from trading/user accounts.
 */
class DataFeedService {
  private adapter: AngelOneAdapter | null = null;
  private jwtToken: string = "";
  private lastRefresh: number = 0;
  private initPromise: Promise<void> | null = null;

  constructor() {
    if (config.dataApiKey) {
      // 🚀 HARD ISOLATION: Flag as dedicated data account
      this.adapter = new AngelOneAdapter(config.dataApiKey, undefined, true);
    }
  }

  /**
   * Initialize or reuse existing session for the Data Feed account
   */
  async init(): Promise<void> {
    if (!this.adapter) {
      log.warn("[DATA_FEED] Not configured. Falling back to dynamic user sessions.");
      return;
    }

    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        log.info("[DATA_FEED] Initializing session...");
        await this.generateSession();
        log.info("[DATA_SESSION_CREATED] Data feed is active.");
      } catch (err: any) {
        log.error("[DATA_SESSION_FAILED] " + err.message);
        this.initPromise = null;
        throw err;
      }
    })();

    return this.initPromise;
  }

  private async generateSession() {
    if (!this.adapter) return;

    try {
      const totp = speakeasy.totp({
        secret: config.dataTotpSecret.replace(/\s/g, ''),
        encoding: "base32",
      });

      // 🔍 [DEBUG] Logic Handshake
      log.info(`[DATA_LOGIN_PAYLOAD] Client: ${config.dataClientCode} | TOTP: ${totp}`);

      const resp = await this.adapter.generateSession({
        clientcode: config.dataClientCode,
        password: config.dataPassword,
        totp: totp,
      });

      if (resp && resp.status === 200 && resp.data) {
        log.info(`[DATA_SESSION_CREATED] Success: ${config.dataClientCode} | Session Token Received.`);
        this.jwtToken = resp.data.jwtToken || resp.data.accessToken;
        this.lastRefresh = Date.now();
      } else {
        log.error(`[DATA_LOGIN_RESPONSE] Broker Error: ${JSON.stringify(resp)}`);
        throw new Error(resp?.data?.message || "Login failed for Data Account");
      }
    } catch (err: any) {
      log.error("[DATA_SESSION_FAILED] Fatal: " + err.message);
      throw err;
    }
  }

  private async ensureValidSession() {
    if (!this.jwtToken || Date.now() - this.lastRefresh > 18 * 60 * 60 * 1000) {
      await this.generateSession();
      log.info("[DATA_SESSION_REFRESHED] Session renewed.");
    }
  }

  /**
   * 🚀 Batch LTP fetch for multiple tokens
   */
  async getLTPBatch(exchangeTokens: Record<string, string[]>): Promise<Record<string, number>> {
    const results: Record<string, number> = {};

    // Fallback if data account isn't configured
    if (!this.adapter) {
        const { getMultipleInstrumentsLtp } = await import("./MarketDataService");
        return await getMultipleInstrumentsLtp(exchangeTokens);
    }

    try {
      await this.ensureValidSession();
      
      // 1. Log outgoing payload
      log.debug("GET_LTP_BATCH_REQUEST: " + JSON.stringify(exchangeTokens));

      const resp = await this.adapter.getMarketData(this.jwtToken, "FULL", exchangeTokens);

      // 2. Log raw response
      log.debug("RAW_QUOTE_RESPONSE: " + JSON.stringify(resp));

      if (resp && resp.status === 200 && resp.data) {
        const fetched = Array.isArray(resp.data) ? resp.data : (resp.data.fetched || []);
        
        // 3. Mapping and Validation
        const allRequestedTokens = Object.values(exchangeTokens).flat();
        const fetchedMap: Record<string, any> = {};
        
        fetched.forEach((item: any) => {
           // Case insensitive matching for symbolToken
           fetchedMap[String(item.symbolToken || item.symboltoken)] = item;
        });

        allRequestedTokens.forEach(token => {
            const data = fetchedMap[token];
            if (data) {
                results[token] = Number(data.ltp || data.lastPrice || 0);
            } else {
                log.warn(`[TOKEN_NOT_FOUND] Broker did not return data for token: ${token}`);
            }
        });

        log.info(`[DATA_FEED_MAPPING] Successfully mapped ${Object.keys(results).length}/${allRequestedTokens.length} tokens.`);
      } else {
         log.warn("[MARKET_DATA_FAILED] Status false or invalid structure from Data Feed.");
      }
    } catch (err: any) {
      log.error("[MARKET_DATA_FAILED] Error: " + err.message);
      // Optional: try fallback to legacy service if this fails
      const { getMultipleInstrumentsLtp } = await import("./MarketDataService");
      return await getMultipleInstrumentsLtp(exchangeTokens);
    }

    return results;
  }
}

export const dataFeedService = new DataFeedService();
