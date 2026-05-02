// src/services/DataFeedService.ts
import redis from "../utils/redis";
import { getInstrumentLtp, getMultipleInstrumentsLtp } from "./MarketDataService";
import log from "../utils/logger";

export class DataFeedService {
    private static instance: DataFeedService;
    private readonly TTL = 5; // 5 seconds cache for LTP

    private constructor() {}

    public static getInstance(): DataFeedService {
        if (!DataFeedService.instance) {
            DataFeedService.instance = new DataFeedService();
        }
        return DataFeedService.instance;
    }

    /**
     * Legacy static-style access for NiftyOptionService
     */
    public static async getLTPBySymbols(symbolGroups: Record<string, string[]>): Promise<Record<string, number>> {
        const instance = DataFeedService.getInstance();
        const results: Record<string, number> = {};
        
        for (const [exchange, symbols] of Object.entries(symbolGroups)) {
            await Promise.all(symbols.map(async (symbol) => {
                // Note: getCachedLtp requires symboltoken which we don't have here.
                // We'll fallback to a simplified version or assume cachedLtp can work with symbol only if we modify it.
                // For now, let's use the instance method but we need tokens.
                results[symbol] = await instance.getCachedLtp(exchange, symbol, ""); 
            }));
        }
        return results;
    }

    /**
     * Get LTP with Redis Caching
     */
    async getCachedLtp(exchange: string, tradingsymbol: string, symboltoken: string): Promise<number> {
        const cacheKey = `LTP:${exchange}:${tradingsymbol}`;
        
        try {
            const cachedValue = await redis.get(cacheKey);
            if (cachedValue) return parseFloat(cachedValue);

            // If no token provided, we can't fetch fresh from broker here safely without more lookups
            if (!symboltoken) return 0;

            const ltp = await getInstrumentLtp(exchange, tradingsymbol, symboltoken);
            if (ltp > 0) {
                await redis.setex(cacheKey, this.TTL, ltp.toString());
            }
            return ltp;
        } catch (error) {
            log.error(`[DataFeedService] Error fetching LTP for ${tradingsymbol}:`, error);
            return 0;
        }
    }

    async getBulkLtp(instruments: { exchange: string; tradingsymbol: string; symboltoken: string }[]): Promise<Record<string, number>> {
        const results: Record<string, number> = {};
        const missingByExch: Record<string, string[]> = {};
        const now = Date.now();

        // 1. Try Cache First
        for (const ins of instruments) {
            const cacheKey = `LTP:${ins.exchange}:${ins.tradingsymbol}`;
            const cachedValue = await redis.get(cacheKey);
            
            if (cachedValue) {
                results[ins.tradingsymbol] = parseFloat(cachedValue);
            } else if (ins.symboltoken) {
                // Prepare for batch fetch
                if (!missingByExch[ins.exchange]) missingByExch[ins.exchange] = [];
                missingByExch[ins.exchange].push(ins.symboltoken);
            }
        }

        // 2. Batch Fetch Missing
        if (Object.keys(missingByExch).length > 0) {
            try {
                const batchResults = await getMultipleInstrumentsLtp(missingByExch);
                
                // Map batch results back to tradingsymbols
                for (const ins of instruments) {
                    if (batchResults[ins.symboltoken]) {
                        const ltp = batchResults[ins.symboltoken];
                        results[ins.tradingsymbol] = ltp;
                        
                        // Cache it for next time
                        const cacheKey = `LTP:${ins.exchange}:${ins.tradingsymbol}`;
                        await redis.setex(cacheKey, this.TTL, ltp.toString());
                    }
                }
            } catch (err: any) {
                log.error("[DataFeedService] Batch fetch failed:", err.message);
            }
        }

        return results;
    }
}

export const dataFeedService = DataFeedService.getInstance();
