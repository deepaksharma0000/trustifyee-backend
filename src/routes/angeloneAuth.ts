import express from 'express';
import { config } from '../config';
import { AngelOneAdapter } from '../adapters/AngelOneAdapter';
import log from '../utils/logger';
import AngelTokensModel from '../models/AngelTokens';
import User from '../models/User';
import Admin from '../models/Admin';
import { encrypt, decrypt, ensureEncrypted } from '../utils/encryption';
import { auth } from '../middleware/auth.middleware';
import AgentModel from '../models/Agent';
import AgentHeartbeatModel from '../models/AgentHeartbeat';
import { BrokerResponse as BrokerResponseModel } from '../models/BrokerResponse';
import { WebSocketAgentServer } from '../services/WebSocketAgentServer';
import crypto from 'crypto';
import { invalidateAngelSessionCache } from '../services/AngelSessionContextService';
import { buildApiKeyRouteBinding, buildBrokerConnectionMetadata } from '../utils/apiKeyRouteBinding';
import { assertApiKeyJwtPair, buildIpWhitelistDiagnostics, validateApiKeyFormat } from '../services/BrokerSessionValidator';
import { isMigrated } from '../utils/encryption';
import {
    assertEncryptedRoundTrip,
    cleanCredentialInput,
    evaluateBrokerCredentialHealth,
    resolveClientCodeInput,
} from '../utils/brokerCredentialHealth';

const router = express.Router();

const MASKED_VALUE_REGEX = /^(\*+|.{1,8}\.\.\.)$/;

const cleanBodyString = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    const clean = value.trim();
    return MASKED_VALUE_REGEX.test(clean) ? '' : clean;
};

const resolveClientCodeFromBody = (body: any): string => {
    return (
        cleanBodyString(body.client_code) ||
        cleanBodyString(body.client_key) ||
        cleanBodyString(body.clientCode) ||
        cleanBodyString(body.clientcode)
    ).toUpperCase();
};

const assertEncryptedValue = (field: string, encrypted: string) => {
    if (!encrypted || encrypted.trim().length < 16) {
        throw new Error(`${field} encryption failed or returned empty`);
    }
};

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
        let client_code: string = resolveClientCodeInput(req.body);
        if (!client_code && profile.client_key) {
            client_code = await ensureEncrypted(profile, 'client_key', `user_${userId}`);
        }

        // Step 3: Resolve password (Request Body > Decrypted Profile)
        let password: string = cleanCredentialInput(req.body.password);
        if (!password && profile.broker_password) {
            password = await ensureEncrypted(profile, 'broker_password', `user_${userId}`);
        }

        // Step 4: Resolve API Key (Request Body > User Profile)
        let resolvedApiKey = "";
        let keySource = 'None';

        const bodyApiKey = cleanCredentialInput(req.body.api_key || req.body.apiKey);
        const profileApiKey = profile.api_key ? await ensureEncrypted(profile, 'api_key', `user_${userId}`) : "";

        if (bodyApiKey) {
            resolvedApiKey = bodyApiKey;
            keySource = 'USER';
        } else if (profileApiKey) {
            resolvedApiKey = profileApiKey;
            keySource = 'USER';
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
        
        const decryptedApiKey = resolvedApiKey;

        // Per-user SmartAPI Private Key only (Working System A — no platform key substitution)
        const sessionApiKey = decryptedApiKey;

        if (!sessionApiKey) {
            return res.status(400).json({
                status: false,
                error: 'AngelOne API Key is missing. Each user must provide their own SmartAPI Private Key.',
            });
        }

        if (isMigrated(sessionApiKey) || String(sessionApiKey).startsWith('enc::')) {
            return res.status(400).json({
                status: false,
                error: 'API key must be plaintext SmartAPI Private Key, not an encrypted database value.',
            });
        }

        const apiKeyFormat = validateApiKeyFormat(sessionApiKey);
        if (!apiKeyFormat.valid) {
            return res.status(400).json({
                status: false,
                error: `Invalid SmartAPI key format (${apiKeyFormat.reason}). Use the Private Key from your Angel One developer app.`,
            });
        }

        // Step 5: Resolve TOTP (Request Body TOTP > Request Body Secret > Profile Secret)
        let totp: string = cleanCredentialInput(req.body.totp);
        let totp_secret: string = cleanCredentialInput(req.body.totp_secret || req.body.totpSecret).toUpperCase();

        // Step 6: Validate required fields (all mandatory for Live trading)
        if (!client_code) {
            return res.status(400).json({ status: false, error: 'Client Code is required. Please enter your AngelOne Client Code.' });
        }
        if (!password) {
            return res.status(400).json({ status: false, error: 'Password is required. Please enter your AngelOne password.' });
        }
        if (!bodyApiKey && !profileApiKey) {
            return res.status(400).json({
                status: false,
                error: 'SmartAPI Private Key (api_key) is required. Register your own Angel One developer app.',
            });
        }
        const hasTotpSecret = Boolean(
            cleanCredentialInput(req.body.totp_secret || req.body.totpSecret) ||
            profile.broker_totp_secret
        );
        if (!hasTotpSecret) {
            return res.status(400).json({
                status: false,
                error: 'TOTP Secret Key is required for automated live trade execution and session recovery.',
            });
        }
        if (!totp && !totp_secret && profile.broker_totp_secret) {
            totp_secret = await ensureEncrypted(profile, 'broker_totp_secret', `user_${userId}`);
            log.info(`[AUTH] Smart Login: Using saved TOTP secret for ${client_code}`);
        }
        if (!totp && !totp_secret) {
            return res.status(400).json({ status: false, error: 'TOTP or TOTP Secret is required. Enter current 6-digit TOTP or your TOTP secret key.' });
        }

        // FIX: Force IPv4 validation and fallback
        const isValidIPv4 = (ip?: string): boolean => 
            !!ip && /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);

        const binding = buildApiKeyRouteBinding(sessionApiKey, {
            outgoingIp: (profile as any).outgoing_ip,
            agentUrl: (profile as any).agent_url,
            dedicatedIpEnabled: Boolean((profile as any).dedicated_ip_enabled === true),
        });
        const routeHeaderIp = isValidIPv4(binding.routeIp) ? binding.routeIp : config.publicIp;

        log.info(`[BROKER_AUTH] Route IP for headers: ${routeHeaderIp} (routeType=${binding.routeType}, profileIp=${(profile as any).outgoing_ip || "none"})`);
        log.info('[IP_WHITELIST_DIAGNOSTICS]', buildIpWhitelistDiagnostics({
            dedicatedIpEnabled: Boolean((profile as any).dedicated_ip_enabled === true),
            userOutgoingIp: (profile as any).outgoing_ip,
        }));

        // Step 7: Call AngelOne API
        const adapter = new AngelOneAdapter(
            sessionApiKey,
            routeHeaderIp,
            false,
            binding.agentUrl || undefined
        );
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

        try {
            assertApiKeyJwtPair(sessionApiKey, jwtToken, client_code);
        } catch (pairErr: any) {
            log.error(`[AUTH] API key / JWT pair validation failed for ${client_code}`, { message: pairErr?.message });
            return res.status(400).json({
                status: false,
                error: pairErr?.message || "API key and session token are inconsistent. Re-enter your SmartAPI Private Key.",
            });
        }

        // Step 8: Save tokens to DB
        const encryptedSessionApiKey = encrypt(sessionApiKey);
        const encryptedProfileApiKey = encrypt(decryptedApiKey);
        await AngelTokensModel.findOneAndUpdate(
            { userId, clientcode: client_code },
            {
                userId,
                clientcode: client_code,
                jwtToken: encrypt(jwtToken),
                refreshToken: encrypt(refreshToken),
                feedToken: encrypt(feedToken),
                apiKey: encryptedSessionApiKey,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
                ...buildBrokerConnectionMetadata({
                    brokerName: "Angel One",
                    apiKey: sessionApiKey,
                    clientCode: client_code,
                    outgoingIp: (profile as any).outgoing_ip,
                    assignedExecutionIp: (profile as any).assignedExecutionIp || (profile as any).outgoing_ip,
                    agentUrl: (profile as any).agent_url,
                    dedicatedIpEnabled: Boolean((profile as any).dedicated_ip_enabled === true),
                    brokerAppName: req.body.broker_app_name || req.body.app_name || req.body.appName,
                    verificationStatus: "VERIFIED",
                    connectionTimestamp: new Date(),
                    brokerLoginTimestamp: new Date(),
                }),
            },
            { upsert: true, new: true }
        );
        invalidateAngelSessionCache(String(userId), String(client_code));

        // Step 9: Build and save profile update
        const encryptedClientCode = encrypt(client_code);
        assertEncryptedRoundTrip('client_key', client_code, encryptedClientCode);

        const updatePayload: any = {
            broker_connected: true,
            broker_verified: true,
            trading_paused: false,
            consecutive_failures: 0,
            client_key: encryptedClientCode,
            broker: 'AngelOne',
            requiresReconnect: false,
        };

        if (userType !== 'admin') {
            updatePayload.api_key_ip_pair_verified = true;
            updatePayload.validated_api_key_fingerprint = binding.apiKeyFingerprint;
            updatePayload.validated_route_ip = binding.routeIp || null;
            updatePayload.validated_route_type = binding.routeType;
            updatePayload.validated_pair_at = new Date();
        }

        // Always save credentials from request body for future auto-login
        if (password) {
            updatePayload.broker_password = encrypt(password);
            assertEncryptedRoundTrip('broker_password', password, updatePayload.broker_password);
        }
        if (bodyApiKey || decryptedApiKey) {
            updatePayload.api_key = encryptedProfileApiKey;
            assertEncryptedRoundTrip('api_key', decryptedApiKey, updatePayload.api_key);
        }
        // FIX #4: Encrypt TOTP secret before persisting to DB
        if (totp_secret) {
            updatePayload.broker_totp_secret = encrypt(totp_secret);
            assertEncryptedRoundTrip('broker_totp_secret', totp_secret, updatePayload.broker_totp_secret);
        }

        if (userType === 'admin') {
            await Admin.updateOne(
                { _id: userId },
                { $set: { ...updatePayload, panel_client_key: client_code } },
                { upsert: false }
            );
        } else {
            await User.updateOne({ _id: userId }, { $set: updatePayload });
        }

        const savedProfile = userType === 'admin'
            ? await Admin.findById(userId).select('+broker_password +broker_totp_secret').lean() as any
            : await User.findById(userId).select('+broker_password +broker_totp_secret client_key api_key broker broker_connected broker_verified').lean() as any;

        log.info('[BROKER_CREDENTIAL_SAVE_HEALTH]', {
            userId,
            userType,
            broker: savedProfile?.broker,
            hasClientKey: Boolean(savedProfile?.client_key),
            clientKeyEncryptedLength: String(savedProfile?.client_key || '').length,
            hasApiKey: Boolean(savedProfile?.api_key),
            hasPassword: Boolean(savedProfile?.broker_password),
            hasTotpSecret: Boolean(savedProfile?.broker_totp_secret),
            brokerConnected: Boolean(savedProfile?.broker_connected),
            brokerVerified: Boolean(savedProfile?.broker_verified),
        });
        evaluateBrokerCredentialHealth(savedProfile, `broker_connect_saved_${userId}`);

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

// GET /api/angelone/auth/agent-status
router.get('/agent-status', auth, async (req: any, res) => {
    const userId = req.id;
    try {
        const profile = await User.findById(userId).select("assignedExecutionIp outgoing_ip");
        let agent = await AgentModel.findOne({ userId });
        let justCreated = false;
        const assignedExecutionIp = String((profile as any)?.assignedExecutionIp || (profile as any)?.outgoing_ip || "").trim();
        
        if (!agent) {
            // Auto-create agent registration for the user
            const agentId = "AGENT-" + crypto.randomBytes(4).toString('hex').toUpperCase();
            const rawSecret = crypto.randomBytes(16).toString('hex');
            const encryptedSecret = encrypt(rawSecret);
            
            agent = await AgentModel.create({
                userId,
                agentId,
                agentSecret: encryptedSecret,
                status: "active",
                assignedExecutionIp: assignedExecutionIp || undefined,
                version: "1.0.0"
            });
            
            (agent as any)._rawSecret = rawSecret;
            justCreated = true;
        } else if (assignedExecutionIp && agent.assignedExecutionIp !== assignedExecutionIp) {
            agent.assignedExecutionIp = assignedExecutionIp;
            await agent.save();
        }
        
        const isOnline = WebSocketAgentServer.isAgentOnline(agent.agentId);
        const heartbeat = await AgentHeartbeatModel.findOne({ agentId: agent.agentId }).sort({ timestamp: -1 });
        
        // Fetch recent logs
        const executionResults = await BrokerResponseModel.find({ userId: String(userId) })
            .sort({ createdAt: -1 })
            .limit(10)
            .lean();
            
        const decryptedSecret = justCreated ? (agent as any)._rawSecret : decrypt(agent.agentSecret);
        const displaySecret = justCreated ? decryptedSecret : decryptedSecret.slice(0, 4) + "****************" + decryptedSecret.slice(-4);
        
        return res.json({
            status: true,
            agentId: agent.agentId,
            agentSecret: displaySecret,
            agentStatus: isOnline ? "ONLINE" : "OFFLINE",
            version: agent.version,
            assignedExecutionIp: agent.assignedExecutionIp || assignedExecutionIp || null,
            lastHeartbeat: heartbeat ? heartbeat.timestamp : null,
            connectedIp: heartbeat ? heartbeat.publicIp : "N/A",
            justCreated,
            logs: executionResults.map((r: any) => ({
                timestamp: r.createdAt,
                tradingsymbol: r.tradingsymbol,
                action: r.action,
                status: r.status,
                message: r.message,
                usedIp: r.usedIp,
                networkRoute: r.networkRoute
            }))
        });
    } catch (err: any) {
        log.error(`[AGENT_STATUS_API_ERROR] Error: ${err.message}`);
        return res.status(500).json({
            status: false,
            error: err.message
        });
    }
});

export default router;

