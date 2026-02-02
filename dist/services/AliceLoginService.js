"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AliceLoginService = void 0;
// src/services/AliceLoginService.ts
const AliceBlueAdapter_1 = require("../adapters/AliceBlueAdapter");
const AliceTokens_1 = __importDefault(require("../models/AliceTokens"));
const speakeasy_1 = __importDefault(require("speakeasy"));
const logger_1 = require("../utils/logger");
const adapter = new AliceBlueAdapter_1.AliceBlueAdapter();
class AliceLoginService {
    /**
     * Login to Alice Blue and store session
     */
    static async login(credentials) {
        try {
            let totpToSend = credentials.totp;
            if (!totpToSend && credentials.totpSecret) {
                totpToSend = speakeasy_1.default.totp({
                    secret: credentials.totpSecret,
                    encoding: "base32"
                });
            }
            if (!totpToSend) {
                throw new Error("TOTP missing: provide totp or totpSecret");
            }
            const sessionResponse = await adapter.getSessionId({
                userId: credentials.userId,
                password: credentials.password,
                totp: totpToSend
            });
            // sessionResponse may be raw object — defensive extraction
            const sessionId = (sessionResponse && (sessionResponse.sessionID || sessionResponse.sessionId)) ||
                (sessionResponse?.data && (sessionResponse.data.sessionID || sessionResponse.data.sessionId)) ||
                null;
            if (!sessionId) {
                logger_1.log.error("No sessionId in response:", JSON.stringify(sessionResponse));
                throw new Error("No session ID received from Alice Blue");
            }
            // Verify session by getting user profile
            const profileResp = await adapter.getUserProfile(sessionId);
            const profile = profileResp?.data || profileResp;
            // Save session to DB with 24h expiry (adjust if API returns TTL)
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
            const saved = await AliceTokens_1.default.findOneAndUpdate({ clientcode: credentials.clientcode }, {
                clientcode: credentials.clientcode,
                sessionId,
                profile,
                expiresAt
            }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
            logger_1.log.info(`Alice Blue session stored for client: ${credentials.clientcode}`);
            return {
                clientcode: credentials.clientcode,
                sessionId,
                profile,
                saved
            };
        }
        catch (error) {
            logger_1.log.error("Alice Blue login failed:", error?.message || error);
            throw error;
        }
    }
    static async validateSession(clientcode) {
        try {
            const tokens = await AliceTokens_1.default.findOne({ clientcode });
            if (!tokens?.sessionId)
                return false;
            if (tokens.expiresAt && tokens.expiresAt < new Date()) {
                await AliceTokens_1.default.deleteOne({ clientcode });
                return false;
            }
            await adapter.getUserProfile(tokens.sessionId);
            return true;
        }
        catch (error) {
            await AliceTokens_1.default.deleteOne({ clientcode });
            return false;
        }
    }
}
exports.AliceLoginService = AliceLoginService;
