"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AliceAuthService = void 0;
// src/services/alice/AliceAuthService.ts
const AliceBlueAdapter_1 = require("../../adapters/AliceBlueAdapter");
const aliceConfig_1 = require("../aliceConfig");
const models_1 = require("../db/models"); // tumhara ORM / query client
const adapter = new AliceBlueAdapter_1.AliceBlueAdapter();
class AliceAuthService {
    static getLoginUrl() {
        return adapter.getLoginUrl();
    }
    static async handleCallback(params) {
        const { authCode, userId, ourUserId } = params;
        const resp = await adapter.getUserSession({ authCode, userId });
        if (resp.stat !== "Ok" || !resp.userSession || !resp.clientId) {
            throw new Error(resp.emsg || "Alice login failed");
        }
        // DB me upsert
        const record = await models_1.db.alice_accounts.upsert({
            where: { our_user_id: ourUserId },
            update: {
                alice_user_id: userId,
                alice_client_id: resp.clientId,
                user_session: resp.userSession,
                // expiry time exact claim se nikal sakte ho (JWT exp), yaha simple placeholder
            },
            create: {
                our_user_id: ourUserId,
                alice_user_id: userId,
                alice_client_id: resp.clientId,
                app_code: aliceConfig_1.aliceConfig.appCode,
                user_session: resp.userSession,
            },
        });
        return record;
    }
    static async logout(ourUserId) {
        // Agar Alice ka explicit logout endpoint ho to yaha call karo.
        // Warna simply local session invalidate:
        await models_1.db.alice_accounts.updateMany({
            where: { our_user_id: ourUserId },
            data: {
                user_session: null,
            },
        });
    }
    static async getActiveSession(ourUserId) {
        const acc = await models_1.db.alice_accounts.findFirst({
            where: { our_user_id: ourUserId },
        });
        if (!acc || !acc.user_session) {
            throw new Error("Alice account not connected / session missing");
        }
        return acc;
    }
}
exports.AliceAuthService = AliceAuthService;
