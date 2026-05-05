// src/services/DataFeedService.ts
import axios, { AxiosInstance } from "axios";
import https from "https";
import redis from "../utils/redis";
import { getInstrumentLtp, getMultipleInstrumentsLtp } from "./MarketDataService";
import log from "../utils/logger";
import { config } from "../config";

export class DataFeedService {
    private static instance: DataFeedService;
    private readonly TTL = 5; // 5 seconds cache for LTP
    private client: AxiosInstance;

    private constructor() {
        // 🛡️ FIX 4: Dedicated Agent with Static IP binding for Data Feed
        const feedAgent = new https.Agent({
            family: 4,
            keepAlive: true,
            localAddress: config.publicIp || undefined
        });

        this.client = axios.create({
            baseURL: config.angelBaseUrl || "https://apiconnect.angelone.in",
            httpsAgent: feedAgent,
            timeout: 30000
        });
    }

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

        for (const ins of instruments) {
            const cacheKey = `LTP:${ins.exchange}:${ins.tradingsymbol}`;
            const cachedValue = await redis.get(cacheKey);
            
            if (cachedValue) {
                results[ins.tradingsymbol] = parseFloat(cachedValue);
            } else if (ins.symboltoken) {
                if (!missingByExch[ins.exchange]) missingByExch[ins.exchange] = [];
                missingByExch[ins.exchange].push(ins.symboltoken);
            }
        }

        if (Object.keys(missingByExch).length > 0) {
            try {
                const batchResults = await getMultipleInstrumentsLtp(missingByExch);
                
                for (const ins of instruments) {
                    if (batchResults[ins.symboltoken]) {
                        const ltp = batchResults[ins.symboltoken];
                        results[ins.tradingsymbol] = ltp;
                        
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
