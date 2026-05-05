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
    let username = "Unknown";
    let licence = "N/A";

    try {
        log.info(`[AUTH_DEBUG] Broker connect route reached. Method: ${req.method}, Path: ${req.path}`);
        log.info(`[AUTH_DEBUG] Request Head: ${JSON.stringify({ userId, userType, ip: req.ip })}`);
        log.info(`[AUTH_DEBUG] Request Body (keys): ${Object.keys(req.body).join(', ')}`);

        // Step 1: Load profile from DB
        const profile = userType === 'admin'
            ? await Admin.findById(userId)
            : await User.findById(userId);
 
        if (!profile) {
            log.error(`[AUTH] generate-session failed: User ${userId} not found`);
            throw new Error("User not found");
        }

        username = (profile as any).user_name || (profile as any).full_name || "Unknown";
        licence = (profile as any).licence || "N/A";
        log.info(`[AUTH] Broker connect initiated: User=${username}, Licence=${licence}, ID=${userId}`);

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

        // Step 4: Resolve API Key (Request Body > User Profile > Env Config)
        let resolvedApiKey = "";
        let keySource = 'None';

        const bodyApiKey = typeof req.body.api_key === 'string' ? req.body.api_key.trim() : "";
        const profileApiKey = profile.api_key ? await ensureEncrypted(profile, 'api_key', `user_${userId}`) : "";
        const envApiKey = config.angelApiKey || "";

        if (bodyApiKey) {
            resolvedApiKey = bodyApiKey;
            keySource = 'USER';
        } else if (profileApiKey) {
            resolvedApiKey = profileApiKey;
            keySource = 'USER';
        } else if (envApiKey) {
            resolvedApiKey = envApiKey;
            keySource = 'SYSTEM';
            log.info(`[API_KEY_SOURCE] SYSTEM | Injecting global key for ${client_code}`);
        }

        if (!resolvedApiKey) {
            log.error(`[AUTH] generate-session failed: API Key missing for user ${userId}`);
            return res.status(400).json({ 
                status: false, 
                error: 'AngelOne API Key is missing. Please provide it in the request or contact system administrator.' 
            });
        }
        
        if (keySource === 'USER') {
            log.info(`[API_KEY_SOURCE] USER (masked) | Using provided key for ${client_code}`);
        }
        
        const decryptedApiKey = resolvedApiKey; // For clarity with existing code

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

        // FIX: Force IPv4 validation and fallback
        const isValidIPv4 = (ip?: string): boolean => 
            !!ip && /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);

        const rawIp = profile.outgoing_ip || config.publicIp;
        const outgoingIp = isValidIPv4(rawIp) ? rawIp : config.publicIp;

        log.info(`[BROKER_AUTH] Final IP: ${outgoingIp} (raw was: ${rawIp})`);

        // Step 7: Call AngelOne API
        const adapter = new AngelOneAdapter(decryptedApiKey, outgoingIp);
        const loginResp = await adapter.generateSession({
            clientcode: client_code,
            password: password,
            totp: totp ?? '',
            totp_secret: totp_secret ?? ''
        });

        if (!loginResp || loginResp.status !== 200 || !loginResp.data || loginResp.data.status !== true) {
            // Provide specific error from broker
            const brokerMsg = loginResp.data?.message || 'Login failed';
            const brokerCode = loginResp.data?.errorcode || 'NO_CODE';
            log.error(`[AUTH] AngelOne REJECTED login for ${username} (${client_code}) | Code: ${brokerCode} | Msg: ${brokerMsg}`);
            
            // Detailed debug log for the full response object if it's not success
            log.debug(`[AUTH_DEBUG] Full Broker Error Response: ${JSON.stringify(loginResp.data || {})}`);

            let hint = "Please check: 1) Client Code & Password correct? 2) TOTP valid? 3) API Key valid & IP whitelisted?";
            if (brokerMsg.includes("Invalid Login Credentials")) {
                hint = "HINT: Most likely your TOTP is invalid or Server Time is out of sync. Please sync your server clock!";
            } else if (brokerMsg.includes("Invalid session")) {
                hint = "HINT: Your API Key may be invalid or your IP is not whitelisted in AngelOne dashboard.";
            }

            return res.status(401).json({
                status: false,
                error: `Broker Error: ${brokerMsg}. ${hint}`
            });
        }

        // 🚀 CORRECT EXTRACTION: loginResp.data.data (Axios body > SmartAPI data object)
        const tokenData = loginResp.data.data;
        
        if (!tokenData) {
            log.error(`[AUTH] Login success but data object is null for ${client_code}`);
            return res.status(500).json({ status: false, error: "Broker returned success but no token data. Please try again." });
        }

        const { jwtToken, refreshToken, feedToken } = tokenData;

        if (!jwtToken) {
            log.error(`[AUTH] Login success but jwtToken missing in data for ${client_code}`);
            return res.status(500).json({ status: false, error: "Broker response missing JWT token" });
        }

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
            trading_paused: false, // [FIX] Reset circuit breaker
            consecutive_failures: 0, // [FIX] Reset failure count
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

        log.info(`[AUTH] ✅ Session generated successfully for ${username} (${client_code}) [${userType}]`);
        return res.json({
            status: true,
            message: 'Broker connected successfully!',
            clientcode: client_code
        });

    } catch (error: any) {
        log.error(`[AUTH_EXCEPTION] Fatal error for User ${username} (${userId}):`, error.message);
        if (error.response) {
            log.error(`[AUTH_EXCEPTION] Broker HTTP Response: ${error.response.status} | Data: ${JSON.stringify(error.response.data)}`);
        }
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

