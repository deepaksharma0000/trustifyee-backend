import express from 'express';
import { config } from '../config';
import { AngelOneAdapter } from '../adapters/AngelOneAdapter';
import { log } from '../utils/logger';
import AngelTokensModel from '../models/AngelTokens';
import User from '../models/User';
import Admin from '../models/Admin';
import { encrypt, decrypt } from '../utils/encryption';
import { auth } from '../middleware/auth.middleware';

const router = express.Router();

// 🚀 Manual Session Generation (SmartAPI loginByPassword Model)
// POST /api/angelone/auth/generate-session
router.post('/generate-session', auth, async (req: any, res) => {
    let { client_code, password, totp, totp_secret } = req.body;
    const userId = req.id;
    const userType = req.userType;

    // 🚀 Fetch profile first to get saved api_key, password and totp_secret
    const profile: any = userType === 'admin' ? await Admin.findById(userId) : await User.findById(userId);
    
    // 1. Get Client Code (Order: Request Body > User Profile)
    if (!client_code && profile?.client_key) {
        client_code = decrypt(profile.client_key);
    }

    // 2. Get Password (Order: Request Body > User Profile)
    if (!password && profile?.broker_password) {
        password = decrypt(profile.broker_password);
    }

    // 3. Get API Key (Order: Request Body > User Profile > Global Config)
    let decryptedApiKey = config.angelApiKey;
    let keySource = "Global Default";

    if (req.body.api_key) {
        decryptedApiKey = req.body.api_key;
        keySource = "Request Body";
    } else if (profile?.api_key) {
        decryptedApiKey = decrypt(profile.api_key);
        keySource = "User Profile";
    }

    log.info(`Generating AngelOne session for ${userType}: ${userId} (${client_code}) using ${keySource} API Key`);

    // [NEW] Smart Login: Fetch saved secret if not provided in the request
    if (!totp && !totp_secret && profile?.broker_totp_secret) {
        totp_secret = profile.broker_totp_secret;
        log.info(`Smart Login: Using saved TOTP secret for ${client_code}`);
    }

    if (!client_code || !password || (!totp && !totp_secret)) {
        return res.status(400).json({ status: false, error: 'Client Code, Password, and either TOTP or TOTP Secret are required' });
    }

    try {
        log.info(`Generating AngelOne session for ${userType}: ${userId} (${client_code})`);

        // Initialize adapter with user-specific API key
        const adapter = new AngelOneAdapter(decryptedApiKey);
        const loginResp = await adapter.generateSession({
            clientcode: client_code,
            password: password,
            totp: totp,
            totp_secret: totp_secret
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
                    apiKey: encrypt(decryptedApiKey),
                    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // Valid for 24h
                },
                { upsert: true }
            );

            // 2. Update Model broker status
            const updatePayload: any = {
                broker_connected: true,
                broker_verified: true,
                client_key: encrypt(client_code),
                broker: 'AngelOne'
            };

            // [NEW] Save Credentials if provided for automated logins in the future
            if (req.body.password) {
                updatePayload.broker_password = encrypt(req.body.password);
            }
            if (req.body.api_key) {
                updatePayload.api_key = encrypt(req.body.api_key);
            }
            if (totp_secret) {
                updatePayload.broker_totp_secret = totp_secret;
            }

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
