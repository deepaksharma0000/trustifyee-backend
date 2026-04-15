import express from 'express';
import { config } from '../config';
import { AngelOneAdapter } from '../adapters/AngelOneAdapter';
import log from '../utils/logger';
import AngelTokensModel from '../models/AngelTokens';
import User from '../models/User';
import Admin from '../models/Admin';
import { encrypt, decrypt, ensureEncrypted } from '../utils/encryption';
import { auth } from '../middleware/auth.middleware';

const router = express.Router();

// 🚀 Manual Session Generation (SmartAPI loginByPassword Model)
// POST /api/angelone/auth/generate-session
router.post('/generate-session', auth, async (req: any, res) => {
    const userId = req.id;
    const userType = req.userType;

    try {
        // Step 1: Load profile from DB
        const profile = userType === 'admin'
            ? await Admin.findById(userId)
            : await User.findById(userId);
 
        if (!profile) {
            throw new Error("User not found");
        }

        // Step 2: Resolve client_code (Request Body > Decrypted Profile)
        let client_code: string = req.body.client_code || '';
        if (!client_code && profile.client_key) {
            client_code = await ensureEncrypted(profile, 'client_key', `user_${userId}`);
        }

        // Step 3: Resolve password (Request Body > Decrypted Profile)
        let password: string = req.body.password || '';
        if (!password && profile.broker_password) {
            password = await ensureEncrypted(profile, 'broker_password', `user_${userId}`);
        }

        // Step 4: Resolve API Key (Request Body > Decrypted Profile)
        let decryptedApiKey = "";
        let keySource = 'None';
        if (req.body.api_key) {
            decryptedApiKey = req.body.api_key;
            keySource = 'Request Body';
        } else if (profile.api_key) {
            decryptedApiKey = await ensureEncrypted(profile, 'api_key', `user_${userId}`);
            keySource = 'User Profile';
        }

        if (!decryptedApiKey) {
            log.error(`[AUTH] generate-session failed: API Key missing for user ${userId}`);
            return res.status(400).json({ 
                status: false, 
                error: 'AngelOne API Key is missing. Please provide it in the request or your user profile.' 
            });
        }

        // Step 5: Resolve TOTP (Request Body TOTP > Request Body Secret > Profile Secret)
        let totp: string = req.body.totp || '';
        let totp_secret: string = req.body.totp_secret || '';
        if (!totp && !totp_secret && profile.broker_totp_secret) {
            totp_secret = await ensureEncrypted(profile, 'broker_totp_secret', `user_${userId}`);
            log.info(`[AUTH] Smart Login: Using saved TOTP secret for ${client_code}`);
        }

        // Step 6: Validate required fields
        if (!client_code) {
            return res.status(400).json({ status: false, error: 'Client Code is required. Please enter your AngelOne Client Code.' });
        }
        if (!password) {
            return res.status(400).json({ status: false, error: 'Password is required. Please enter your AngelOne password.' });
        }
        if (!totp && !totp_secret) {
            return res.status(400).json({ status: false, error: 'TOTP or TOTP Secret is required. Enter current 6-digit TOTP or your TOTP secret key.' });
        }

        log.info(`[AUTH] Generating session: ${userType}=${userId}, client=${client_code}, apiKeySource=${keySource}`);

        // Step 7: Call AngelOne API
        const adapter = new AngelOneAdapter(decryptedApiKey, profile.outgoing_ip);
        const loginResp = await adapter.generateSession({
            clientcode: client_code,
            password: password,
            totp: totp ?? '',
            totp_secret: totp_secret ?? ''
        });

        if (!loginResp || loginResp.status !== 200 || !loginResp.data) {
            // Provide specific error from broker
            const brokerMsg = loginResp.data?.message || 'Login failed';
            log.error(`[AUTH] AngelOne rejected login for ${client_code}: ${brokerMsg}`);
            return res.status(401).json({
                status: false,
                error: `Broker Error: ${brokerMsg}. Please check: 1) Client Code correct? 2) Password correct? 3) TOTP valid (use current 6-digit code)?`
            });
        }

        const { jwtToken, refreshToken, feedToken } = loginResp.data;

        // Step 8: Save tokens to DB
        await AngelTokensModel.findOneAndUpdate(
            { userId, clientcode: client_code },
            {
                userId,
                clientcode: client_code,
                jwtToken: encrypt(jwtToken),
                refreshToken: encrypt(refreshToken),
                feedToken: encrypt(feedToken),
                apiKey: encrypt(decryptedApiKey),
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h
            },
            { upsert: true, new: true }
        );

        // Step 9: Build and save profile update
        const updatePayload: any = {
            broker_connected: true,
            broker_verified: true,
            client_key: encrypt(client_code),
            broker: 'AngelOne'
        };

        // Always save credentials from request body for future auto-login
        if (req.body.password) {
            updatePayload.broker_password = encrypt(req.body.password);
        }
        if (req.body.api_key) {
            updatePayload.api_key = encrypt(req.body.api_key);
        }
        // FIX #4: Encrypt TOTP secret before persisting to DB
        if (req.body.totp_secret) {
            updatePayload.broker_totp_secret = encrypt(req.body.totp_secret);
        }

        if (userType === 'admin') {
            await Admin.updateOne(
                { panel_client_key: client_code },
                { ...updatePayload, panel_client_key: client_code },
                { upsert: true }
            );
        } else {
            await User.updateOne({ _id: userId }, updatePayload);
        }

        log.info(`[AUTH] ✅ Session generated successfully for ${client_code} (${userType})`);
        return res.json({
            status: true,
            message: 'Broker connected successfully!',
            clientcode: client_code
        });

    } catch (error: any) {
        log.error('[AUTH] generate-session exception:', error.message);
        // Surface the real broker error clearly
        const msg = error.message || 'Unknown error';
        return res.status(500).json({
            status: false,
            error: msg.includes('generateSession failed:')
                ? msg.replace('generateSession failed: ', 'Broker rejected: ')
                : msg
        });
    }
});

export default router;

