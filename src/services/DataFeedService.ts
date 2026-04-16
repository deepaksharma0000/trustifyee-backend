import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import { config } from "../config";
import log from "../utils/logger";
import speakeasy from "speakeasy";

/**
 * 💹 [DATA LAYER] Dedicated Data Feed Service
 * Uses a single dedicated broker account for all market data needs.
 * Ensures strict isolation from trading/user accounts.
 */
export class DataFeedService {
  private static adapter: AngelOneAdapter | null = null;
  private static jwtToken: string = "";
  private static lastRefresh: number = 0;
  private isInitializing = false;

  // 🚀 [REAL-TIME TOKEN & LTP CACHE]
  private static tokenCache = new Map<string, { token: string; ts: number }>();
  private static ltpCache = new Map<string, { ltp: number; ts: number }>();
  private static readonly CACHE_TTL = 10 * 60 * 1000; // 10 Minutes
  private static readonly LTP_CACHE_TTL = 1500; // 1.5 Seconds for real-time feel

  constructor() {
    if (config.dataApiKey && !DataFeedService.adapter) {
      // 🚀 HARD ISOLATION: Flag as dedicated data account
      DataFeedService.adapter = new AngelOneAdapter(config.dataApiKey, undefined, true);
    }
  }

  /**
   * 🚀 SESSION INJECTION (Production Fix)
   * Allows Auth controller to directly inject a working session.
   */
  public static setSession(jwtToken: string, apiKey: string) {
    DataFeedService.jwtToken = jwtToken;
    DataFeedService.adapter = new AngelOneAdapter(apiKey, undefined, true);
    DataFeedService.lastRefresh = Date.now();
    log.info("[DATA_FEED] Session injected successfully. Service is ready.");
  }

  /**
   * Initialize or reuse existing session for the Data Feed account
   */
  async init(): Promise<void> {
    if (this.isInitializing) return;
    if (DataFeedService.jwtToken) return;

    if (!config.dataApiKey || !config.dataClientCode) {
      log.warn("[DATA_FEED] Dedicated credentials missing. Waiting for session injection...");
      return;
    }

    this.isInitializing = true;
    try {
      log.info("[DATA_FEED] Initializing session via Dedicated Account...");
      if (!DataFeedService.adapter) {
          DataFeedService.adapter = new AngelOneAdapter(config.dataApiKey, undefined, true);
      }
      await this.generateSession();
      log.info("[DATA_SESSION_CREATED] Data feed is active.");
    } catch (err: any) {
      log.error("[DATA_SESSION_FAILED] " + err.message);
    } finally {
      this.isInitializing = false;
    }
  }

  private async generateSession() {
    if (!DataFeedService.adapter) return;

    try {
      const totp = speakeasy.totp({
        secret: config.dataTotpSecret.replace(/\s/g, ''),
        encoding: "base32",
      });

      const resp = await DataFeedService.adapter.generateSession({
        clientcode: config.dataClientCode,
        password: config.dataPassword,
        totp: totp,
      });

      if (resp && resp.status === 200 && resp.data?.status === true) {
        log.info(`[DATA_SESSION_CREATED] Success: ${config.dataClientCode} | Session Token Received.`);
        
        const tokenData = resp.data.data;
        DataFeedService.jwtToken = tokenData?.jwtToken;
        DataFeedService.lastRefresh = Date.now();
        
        if (!DataFeedService.jwtToken) {
            log.error("[TOKEN_ASSIGNMENT_FAILED] JWT missing in response.");
            throw new Error("JWT missing");
        }

        log.info("[TOKEN_STORED] YES", { 
            tokenPreview: DataFeedService.jwtToken.substring(0, 10) + "..."
        });
      } else {
        log.error(`[DATA_LOGIN_RESPONSE] Broker Error: ${JSON.stringify(resp.data || resp)}`);
        throw new Error(resp?.data?.message || "Login failed");
      }
    } catch (err: any) {
      log.error("[DATA_SESSION_FAILED] Fatal: " + err.message);
      throw err;
    }
  }

  private async ensureValidSession() {
    if (!DataFeedService.jwtToken) return; // Don't auto-init here
    if (Date.now() - DataFeedService.lastRefresh > 18 * 60 * 60 * 1000) {
      await this.generateSession();
      log.info("[DATA_SESSION_REFRESHED] Session renewed.");
    }
  }

  /**
   * 🚀 Dynamic Token Resolution (searchScrip)
   * Converts Tradingsymbol -> SymbolToken in real-time
   */
  /**
   * 🚀 Dynamic Token Resolution (searchScrip)
   * Converts Tradingsymbol -> SymbolToken in real-time
   */
  public static async resolveSymbols(exchange: string, symbols: string[]): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};
    
    // 🛡️ STRICT GUARD: No per-request re-init
    if (!DataFeedService.adapter || !DataFeedService.jwtToken) {
       log.error("[DATA_FEED] Session not initialized or adapter missing. Skipping resolution.");
       return resolved;
    }

    for (const symbol of symbols) {
      if (!symbol) continue;

      const cacheKey = `${exchange}:${symbol}`;
      const cached = DataFeedService.tokenCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < DataFeedService.CACHE_TTL) {
        resolved[symbol] = cached.token;
        log.info(`[RESOLVED_TOKEN_MAP] (Cached) Requested: ${symbol} | Token: ${cached.token}`);
        continue;
      }

      try {
        // 🚀 1. Try Broker searchScrip First
        let match: any = null;
        try {
          const resp = await DataFeedService.adapter!.searchScrip(DataFeedService.jwtToken, exchange, symbol);
          
          // 🔍 CORRECT PARSING: SmartAPI search results are in resp.data.data
          const results = resp.data?.data || (Array.isArray(resp.data) ? resp.data : []);
          
          if (resp && resp.status === 200 && Array.isArray(results)) {
            match = results.find((item: any) => {
              const symMatch = String(item.tradingsymbol).trim().toUpperCase() === symbol.trim().toUpperCase();
              const exchMatch = String(item.exchange).trim().toUpperCase() === exchange.trim().toUpperCase();
              const isOption = exchange === "NFO" ? (item.instrumenttype === "OPTIDX" || item.instrumenttype === "OPTSTK") : true;
              return symMatch && exchMatch && isOption;
            });
          }
        } catch (brokerErr: any) {
            if (brokerErr.message.includes("403")) {
                log.warn(`[RESOLVE_BYPASS] searchScrip 403 for ${symbol}. Falling back to DB.`);
            } else {
                log.error(`[RESOLVE_BROKER_FAIL] ${symbol}: ${brokerErr.message}`);
            }
        }

        // 🚀 2. Fallback to Local DB (Instrument master) if Broker search failed or was restricted
        if (!match) {
            const InstrumentModel = (await import("../models/Instrument")).default;
            const dbMatch = await InstrumentModel.findOne({ 
                exchange: exchange.toUpperCase(),
                tradingsymbol: symbol.toUpperCase() 
            }).lean() as any;

            if (dbMatch && dbMatch.symboltoken) {
                match = {
                    symboltoken: dbMatch.symboltoken,
                    tradingsymbol: dbMatch.tradingsymbol,
                    instrumenttype: dbMatch.instrumenttype || "OPTIDX"
                };
                log.info(`[RESOLVED_TOKEN_DB] Requested: ${symbol} | Token: ${match.symboltoken} (resolved via DB)`);
            }
        }

        if (match && match.symboltoken) {
          const token = String(match.symboltoken);
          resolved[symbol] = token;
          DataFeedService.tokenCache.set(cacheKey, { token, ts: Date.now() });
          
          if (!match.instrumenttype) { // Log successful resolution
             log.info(`[RESOLVED_TOKEN_MAP] Requested: ${symbol} | Token: ${token}`);
          } else {
             log.info(`[RESOLVED_TOKEN_MAP] Requested: ${symbol} | Resolved: ${match.tradingsymbol} | Token: ${token} | Type: ${match.instrumenttype}`);
          }
        } else {
          log.error(`[RESOLVE_FAILED_FULLY] Could not find token for ${symbol} in Broker or DB.`);
        }
      } catch (err: any) {
        log.error(`[RESOLVE_FATAL_ERROR] ${symbol}: ${err.message}`);
      }
    }
    return resolved;
  }

  /**
   * 🚀 Batch LTP fetch with STRICT Dynamic Resolution
   */
  public static async getLTPBatchBySymbols(exchangeSymbols: Record<string, string[]>): Promise<Record<string, number>> {
    const now = Date.now();
    log.info(`[LTP_FLOW_TRIGGERED] [DATA_FEED_STATE] hasAdapter: ${!!DataFeedService.adapter} | hasToken: ${!!DataFeedService.jwtToken}`);
    log.info(`[LTP_FLOW_TRIGGERED] Resolving symbols for batch: ${JSON.stringify(exchangeSymbols)}`);
    const results: Record<string, number> = {};
    if (!DataFeedService.adapter) {
        log.warn("[DATA_FEED] Adapter not initialized.");
        return results;
    }

    try {
      if (DataFeedService.jwtToken && now - DataFeedService.lastRefresh > 18 * 60 * 60 * 1000) {
          log.warn("[DATA_FEED] Session might be expired.");
      }

      const exchangeTokens: Record<string, string[]> = {};
      const tokenToSymbolMap: Record<string, string> = {};

      for (const exch in exchangeSymbols) {
        const symbols = exchangeSymbols[exch];
        
        // 🚀 1. Resolve from Cache First (to avoid redundant Broker calls)
        const symbolsToResolve: string[] = [];
        for (const symbol of symbols) {
            const cacheKey = `${exch}:${symbol}`;
            const cached = DataFeedService.ltpCache.get(cacheKey);
            if (cached && (now - cached.ts < DataFeedService.LTP_CACHE_TTL)) {
                results[symbol] = cached.ltp;
            } else {
                symbolsToResolve.push(symbol);
            }
        }

        if (symbolsToResolve.length === 0) continue;

        // 🚀 2. Resolve Remaining Symbols to Tokens
        const resolved = await DataFeedService.resolveSymbols(exch, symbolsToResolve);
        
        const validTokens: string[] = [];
        for (const sym in resolved) {
            const token = resolved[sym];
            validTokens.push(token);
            tokenToSymbolMap[token] = sym;
        }

        if (validTokens.length > 0) {
            // 🚀 3. Only pass resolved tokens to LTP batch
            exchangeTokens[exch] = validTokens;
        }
      }

      if (Object.keys(exchangeTokens).length === 0) {
        // results might already have cached values, so return them instead of warning
        return results;
      }

      const resp = await DataFeedService.adapter!.getMarketData(DataFeedService.jwtToken, "FULL", exchangeTokens);
      log.info("RAW_QUOTE_RESPONSE_DATA: " + JSON.stringify(resp?.data || {}));

      if (resp && resp.status === 200 && resp.data) {
        const fetched = resp.data?.data?.fetched || (Array.isArray(resp.data?.data) ? resp.data.data : []);
        
        fetched.forEach((item: any) => {
            const token = String(item.symbolToken || item.symboltoken);
            const symbol = tokenToSymbolMap[token];
            const ltp = Number(item.ltp || item.lastPrice || 0);
            
            if (symbol) {
              results[symbol] = ltp;
              // Also cache for future use
              const exchange = item.exchange || "NFO";
              DataFeedService.ltpCache.set(`${exchange}:${symbol}`, { ltp, ts: now });
              log.info(`[LTP_MAPPED] ${symbol} -> ${ltp}`);
            }
            results[token] = ltp;
        });
      }
    } catch (err: any) {
      log.error("[DATA_BATCH_FAILED] " + err.message);
    }
    return results;
  }

  /**
   * 🚀 Batch LTP fetch with STRICT Dynamic Resolution
   */
  public static async getLTPBySymbols(exchangeSymbols: Record<string, string[]>): Promise<Record<string, number>> {
    log.info(`[LTP_FLOW_TRIGGERED] Inside DataFeedService.getLTPBySymbols: ${JSON.stringify(exchangeSymbols)}`);
    return DataFeedService.getLTPBatchBySymbols(exchangeSymbols);
  }

  public static async getLTPBatch(exchangeTokens: Record<string, string[]>): Promise<Record<string, number>> {
      log.info(`[LTP_FLOW_TRIGGERED] Legacy getLTPBatch called. Forwarding to symbols resolver.`);
      return DataFeedService.getLTPBatchBySymbols(exchangeTokens);
  }
}

export const dataFeedService = new DataFeedService();
