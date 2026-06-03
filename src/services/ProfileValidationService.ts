import log from "../utils/logger";
import { executeWithSessionRecovery } from "./AngelSessionManager";
import { findAngelTokensForUserClient } from "./AngelSessionContextService";

const profileCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export class ProfileValidationService {
    static async validateUserSession(userId: string, clientcode: string) {
        const cacheKey = `${userId}-${clientcode}`;
        const cached = profileCache.get(cacheKey);

        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
            log.debug(`Using cached profile for ${clientcode}`);
            return { status: true, data: cached.data, message: "Session Active" };
        }

        try {
            const tokens = await findAngelTokensForUserClient(userId, clientcode);
            if (!tokens?.jwtToken) {
                return { status: false, message: `No active broker session for ${clientcode}` };
            }

            const profile = await executeWithSessionRecovery(
                {
                    userId,
                    clientcode,
                    purpose: "profile_validation",
                },
                (session) => session.adapter.getProfile(session.jwtToken)
            );

            if (profile && profile.status === 200) {
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
