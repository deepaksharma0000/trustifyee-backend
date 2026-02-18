import express from 'express';
import { AngelOneAdapter } from '../adapters/AngelOneAdapter';
import { log } from '../utils/logger';
import AngelTokensModel from '../models/AngelTokens';
import User from '../models/User';
import Admin from '../models/Admin';
import { encrypt } from '../utils/encryption';
import { auth } from '../middleware/auth.middleware';

const router = express.Router();

// 🚀 Manual Session Generation (SmartAPI loginByPassword Model)
// POST /api/angelone/auth/generate-session
router.post('/generate-session', auth, async (req: any, res) => {
    const { client_code, password, totp } = req.body;
    const userId = req.id;
    const userType = req.userType;

    if (!client_code || !password || !totp) {
        return res.status(400).json({ status: false, error: 'Client Code, Password, and TOTP are required' });
    }

    try {
        log.info(`Generating AngelOne session for ${userType}: ${userId} (${client_code})`);

        const adapter = new AngelOneAdapter();
        const loginResp = await adapter.generateSession({
            clientcode: client_code,
            password: password,
            totp: totp
        });

        if (loginResp.status && loginResp.data) {
            const { jwtToken, refreshToken, feedToken } = loginResp.data;

            // 1. Save Tokens Securely (Encrypted)
            await AngelTokensModel.findOneAndUpdate(
                { userId, clientcode: client_code },
                {
                    userId,
                    clientcode: client_code,
                    jwtToken: encrypt(jwtToken),
                    refreshToken: encrypt(refreshToken),
                    feedToken: encrypt(feedToken),
                    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // Valid for 24h
                },
                { upsert: true }
            );

            // 2. Update Model broker status
            const updatePayload = {
                broker_connected: true,
                broker_verified: true,
                client_key: encrypt(client_code),
                broker: 'AngelOne'
            };

            if (userType === 'admin') {
                await Admin.findByIdAndUpdate(userId, updatePayload);
                // Also update panel_client_key if it's not set or different
                await Admin.findByIdAndUpdate(userId, { panel_client_key: client_code });
            } else {
                await User.findByIdAndUpdate(userId, updatePayload);
            }

            log.info(`Manual session generated successfully for ${client_code} (${userType})`);
            return res.json({
                status: true,
                message: 'Login successful! Broker connected.',
                clientcode: client_code
            });
        } else {
            throw new Error(loginResp.message || 'AngelOne login failed. Check credentials or TOTP.');
        }
    } catch (error: any) {
        log.error('generate-session error:', error.message);
        res.status(401).json({ status: false, error: error.message });
    }
});

export default router;
