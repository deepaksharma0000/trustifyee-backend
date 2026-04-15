import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import AngelTokensModel from "../models/AngelTokens";
import log from "../utils/logger";
import User from "../models/User";

const profileCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export class ProfileValidationService {
    // Removed global static adapter to prevent startup crash
    // private static adapter = new AngelOneAdapter();

    static async validateUserSession(userId: string, clientcode: string) {
        const cacheKey = `${userId}-${clientcode}`;
        const cached = profileCache.get(cacheKey);

        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
            log.debug(`Using cached profile for ${clientcode}`);
            return { status: true, data: cached.data, message: "Session Active" };
        }

        try {
            const tokens = await AngelTokensModel.findOne({ userId, clientcode }).lean() as any;
            if (!tokens?.jwtToken) {
                return { status: false, message: "No active broker session found" };
            }

            const { createAngelAdapter } = await import('../utils/broker');
            const adapter = await createAngelAdapter(userId.toString());

            const profile = await adapter.getProfile(tokens.jwtToken);

            if (profile && profile.status === 200) {
                // Check for exchange permission
                // Robust check for F&O permissions
                const exchanges = (profile.data?.exchanges || []).map((e: string) => e.toUpperCase().trim());
                const fnoSegments = ["NFO", "NSE_FO", "BFO", "BSE_FO", "MCX_FO", "CDE_FO"];
                const hasFno = exchanges.some(e => fnoSegments.includes(e));

                if (!hasFno) {
                    log.warn(`Segment Check Failed for ${clientcode}. Found: [${exchanges.join(",")}] but F&O segments missing.`);
                    return { status: false, message: "NFO (Options) permission missing in broker profile" };
                }

                // Cache it
                profileCache.set(cacheKey, { data: profile.data, timestamp: Date.now() });

                log.info(`PRE_VALIDATION_SUCCESS: Profile validated for ${clientcode}`);
                return { status: true, data: profile.data, message: "Session Active" };
            }

            log.error(`PRE_VALIDATION_FAILED: Profile check failed for ${clientcode}: ${profile.data?.message}`);
            return { status: false, message: profile.data?.message || "Broker profile check failed" };

        } catch (error: any) {
            log.error(`PROFILE_INVALID: Exception during profile validation for ${clientcode}: ${error.message}`);
            return { status: false, message: error.message };
        }
    }

    static clearCache(userId: string, clientcode: string) {
        profileCache.delete(`${userId}-${clientcode}`);
    }
}
