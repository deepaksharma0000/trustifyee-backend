"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const AngelOneAdapter_1 = require("../adapters/AngelOneAdapter");
const logger_1 = require("../utils/logger");
const AngelTokens_1 = __importDefault(require("../models/AngelTokens"));
const User_1 = __importDefault(require("../models/User"));
const Admin_1 = __importDefault(require("../models/Admin"));
const encryption_1 = require("../utils/encryption");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = express_1.default.Router();
// 🚀 Manual Session Generation (SmartAPI loginByPassword Model)
// POST /api/angelone/auth/generate-session
router.post('/generate-session', auth_middleware_1.auth, async (req, res) => {
    const { client_code, password, totp } = req.body;
    const userId = req.id;
    const userType = req.userType;
    if (!client_code || !password || !totp) {
        return res.status(400).json({ status: false, error: 'Client Code, Password, and TOTP are required' });
    }
    try {
        logger_1.log.info(`Generating AngelOne session for ${userType}: ${userId} (${client_code})`);
        const adapter = new AngelOneAdapter_1.AngelOneAdapter();
        const loginResp = await adapter.generateSession({
            clientcode: client_code,
            password: password,
            totp: totp
        });
        if (loginResp.status && loginResp.data) {
            const { jwtToken, refreshToken, feedToken } = loginResp.data;
            // 1. Save Tokens Securely (Encrypted)
            await AngelTokens_1.default.findOneAndUpdate({ userId, clientcode: client_code }, {
                userId,
                clientcode: client_code,
                jwtToken: (0, encryption_1.encrypt)(jwtToken),
                refreshToken: (0, encryption_1.encrypt)(refreshToken),
                feedToken: (0, encryption_1.encrypt)(feedToken),
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // Valid for 24h
            }, { upsert: true });
            // 2. Update Model broker status
            const updatePayload = {
                broker_connected: true,
                broker_verified: true,
                client_key: (0, encryption_1.encrypt)(client_code),
                broker: 'AngelOne'
            };
            if (userType === 'admin') {
                await Admin_1.default.findByIdAndUpdate(userId, updatePayload);
                // Also update panel_client_key if it's not set or different
                await Admin_1.default.findByIdAndUpdate(userId, { panel_client_key: client_code });
            }
            else {
                await User_1.default.findByIdAndUpdate(userId, updatePayload);
            }
            logger_1.log.info(`Manual session generated successfully for ${client_code} (${userType})`);
            return res.json({
                status: true,
                message: 'Login successful! Broker connected.',
                clientcode: client_code
            });
        }
        else {
            throw new Error(loginResp.message || 'AngelOne login failed. Check credentials or TOTP.');
        }
    }
    catch (error) {
        logger_1.log.error('generate-session error:', error.message);
        res.status(401).json({ status: false, error: error.message });
    }
});
exports.default = router;
