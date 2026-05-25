import { Request, Response } from 'express';
import User from '../models/User';
import Joi from 'joi';
import bcrypt from 'bcryptjs';
import { encrypt, maskKey, decrypt } from '../utils/encryption';
import AngelTokensModel from '../models/AngelTokens';
import UpstoxTokensModel from '../models/UpstoxTokens';
import log from '../utils/logger';
import { cleanCredentialInput, resolveClientCodeInput, encryptRequiredCredential } from '../utils/brokerCredentialHealth';
import { executeWithSessionRecovery } from '../services/AngelSessionManager';

const updateUserSchema = Joi.object({
    full_name: Joi.string().optional(),
    phone_number: Joi.string().optional(),
    broker: Joi.string().allow('', null).optional(),
    status: Joi.string().valid('active', 'inactive').optional(),
    trading_status: Joi.string().valid('enabled', 'disabled').optional(),
    start_date: Joi.date().optional(),
    end_date: Joi.date().optional(),
    licence: Joi.string().valid('Live', 'Demo').optional(),
    to_month: Joi.string().allow('', null).optional(),
    sub_admin: Joi.string().allow('', null).optional(),
    service_to_month: Joi.string().allow('', null).optional(),
    group_service: Joi.string().allow('', null).optional(),
    strategies: Joi.array().items(Joi.string()).optional(),
    api_key: Joi.string().allow('', null).optional(),
    client_key: Joi.string().allow('', null).optional(),
    is_online: Joi.boolean().optional(),
    is_login: Joi.boolean().optional(),
    is_star: Joi.boolean().optional(),
    outgoing_ip: Joi.string().allow('', null).optional(),
    agent_url: Joi.string().uri().allow('', null).optional(),
    dedicated_ip_enabled: Joi.boolean().optional(),
    api_key_ip_pair_verified: Joi.boolean().optional(),
    validated_api_key_fingerprint: Joi.string().allow('', null).optional(),
    validated_route_ip: Joi.string().allow('', null).optional(),
    validated_route_type: Joi.string().valid('USER_STATIC_IP', 'SERVER_SHARED_IP', 'AGENT_ROUTE', 'UNKNOWN').optional(),
    validated_pair_at: Joi.date().optional(),
}).unknown(true);

export const updateUser = async (req: any, res: Response) => {
    try {
        const { id } = req.params;
        const { error, value } = updateUserSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.message, status: false });

        const userToUpdate = await User.findById(id);
        if (!userToUpdate) return res.status(404).json({ error: "User not found", status: false });

        const updateData: any = { ...value };
        const actor = (req as any).user;
        if (!actor) return res.status(401).json({ error: "Unauthorized: Actor not identified.", status: false });

        delete updateData.password;
        delete updateData.email;
        delete updateData.user_name;
        delete updateData.broker_verified;

        if (req.body.client_key) updateData.client_key = encrypt(req.body.client_key);
        if (req.body.api_key) updateData.api_key = encrypt(req.body.api_key);

        const shouldResetKeyIpValidation =
            Object.prototype.hasOwnProperty.call(req.body, "api_key") ||
            Object.prototype.hasOwnProperty.call(req.body, "outgoing_ip") ||
            Object.prototype.hasOwnProperty.call(req.body, "agent_url") ||
            Object.prototype.hasOwnProperty.call(req.body, "dedicated_ip_enabled");

        if (shouldResetKeyIpValidation) {
            updateData.api_key_ip_pair_verified = false;
            updateData.validated_api_key_fingerprint = undefined;
            updateData.validated_route_ip = undefined;
            updateData.validated_route_type = undefined;
            updateData.validated_pair_at = undefined;
        }

        if (actor.role === 'sub-admin' || actor.role === 'subadmin') {
            if (!actor.all_permission) {
                if (updateData.licence !== undefined && updateData.licence !== userToUpdate.licence && !actor.licence_permission) {
                    return res.status(403).json({ error: "Access Denied: You do not have permission to change Licence (Live/Demo)", status: false });
                }
                const stratChanged = updateData.strategies !== undefined && JSON.stringify(updateData.strategies) !== JSON.stringify(userToUpdate.strategies);
                if (stratChanged && !actor.strategy_permission) {
                    return res.status(403).json({ error: "Access Denied: You do not have permission to change Strategies", status: false });
                }
                if (updateData.group_service !== undefined && updateData.group_service !== userToUpdate.group_service && !actor.group_service_permission) {
                    return res.status(403).json({ error: "Access Denied: You do not have permission to change Group Services", status: false });
                }
            }
        }

        await User.updateOne({ _id: id }, updateData);
        const updatedUser = await User.findById(id);
        if (!updatedUser) return res.status(404).json({ error: "User not found", status: false });

        const maskedUpdatedUser = {
            ...updatedUser.toObject(),
            client_key: maskKey(updatedUser.client_key || ""),
            api_key: maskKey(updatedUser.api_key || "")
        };

        res.status(200).json({
            message: "Profile updated successfully!",
            data: maskedUpdatedUser,
            status: true
        });

    } catch (err: any) {
        if (err.code === 11000) {
            return res.status(400).json({ error: "Duplicate error", status: false });
        }
        res.status(500).json({ error: err.message, status: false });
    }
};

export const updateUserBroker = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const clientKey = resolveClientCodeInput(req.body);
        const apiKey = cleanCredentialInput(req.body.api_key || req.body.apiKey);
        const password = cleanCredentialInput(req.body.password || req.body.broker_password);
        const totpSecret = cleanCredentialInput(req.body.totp_secret || req.body.totpSecret || req.body.broker_totp_secret).toUpperCase();

        const updateData: any = {};
        if (clientKey) updateData.client_key = encryptRequiredCredential('client_key', clientKey);
        if (apiKey) updateData.api_key = encryptRequiredCredential('api_key', apiKey);
        if (password) updateData.broker_password = encryptRequiredCredential('broker_password', password);
        if (totpSecret) updateData.broker_totp_secret = encryptRequiredCredential('broker_totp_secret', totpSecret);

        if (!Object.keys(updateData).length) {
            return res.status(400).json({
                error: "No broker credentials provided. Empty or masked credentials are not saved.",
                status: false
            });
        }

        updateData.broker_verified = false;
        updateData.broker_connected = false;
        updateData.api_key_ip_pair_verified = false;
        updateData.validated_api_key_fingerprint = undefined;
        updateData.validated_route_ip = undefined;
        updateData.validated_route_type = undefined;
        updateData.validated_pair_at = undefined;

        await User.updateOne({ _id: id }, { $set: updateData });
        const updatedUser = await User.findById(id);
        if (!updatedUser) return res.status(404).json({ error: "User not found", status: false });

        res.status(200).json({
            message: "Broker details updated successfully! Pending admin approval.",
            status: true
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
};

export const deleteUser = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const deleted = await User.findByIdAndDelete(id);
        if (!deleted) return res.status(404).json({ message: "User not found", status: false });

        res.status(200).json({ message: "User deleted successfully!", status: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const getLoggedInUsers = async (req: Request, res: Response) => {
    try {
        const { filter } = req.query;
        let query: any = { is_login: true };

        if (filter === 'offline') {
            query = { is_login: { $ne: true } };
        }

        const users = await User.find(query).select('-password');
        const maskedUsers = users.map(u => ({
            ...u.toObject(),
            client_key: maskKey(u.client_key || ""),
            api_key: maskKey(u.api_key || "")
        }));
        res.status(200).json({
            message: "Logged-in users fetched successfully!",
            count: users.length,
            data: maskedUsers,
            status: true
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const getStarUsers = async (req: Request, res: Response) => {
    try {
        const users = await User.find({ is_star: true }).select('-password');
        const maskedUsers = users.map(u => ({
            ...u.toObject(),
            client_key: maskKey(u.client_key || ""),
            api_key: maskKey(u.api_key || "")
        }));
        res.status(200).json({
            message: "Star clients fetched successfully!",
            count: users.length,
            data: maskedUsers,
            status: true
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const getUserTotalCount = async (req: Request, res: Response) => {
    try {
        const count = await User.countDocuments();
        res.status(200).json({ total_users: count, status: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const getUsersByEndDate = async (req: Request, res: Response) => {
    try {
        const { filter, date } = req.query;
        let query: any = {};
        const today = new Date();

        if (filter === "expired") {
            query.end_date = { $lt: today };
        } else if (filter === "active") {
            query.end_date = { $gte: today };
        } else if (filter === "custom" && date) {
            const customDate = new Date(date as string);
            customDate.setHours(23, 59, 59, 999);
            query.end_date = { $lte: customDate };
        }

        const actor = (req as any).user;
        if (actor && (actor.role === 'sub-admin' || actor.role === 'subadmin')) {
            if (!actor.all_permission) {
                query.sub_admin = actor.full_name;
            }
        }

        const users = await User.find(query).select("-password");

        const enrichedUsers = await Promise.all(
            users.map(async (u) => {
                const base = {
                    ...u.toObject(),
                    client_key: maskKey(u.client_key || ""),
                    api_key: maskKey(u.api_key || ""),
                    broker_session_active: false,
                };
                if (u.licence === 'Live' && u.client_key) {
                    try {
                        const clientcode = decrypt(u.client_key);
                        const now = new Date();
                        const angelToken = await AngelTokensModel.findOne({
                            userId: u._id,
                            clientcode,
                            expiresAt: { $gt: now }
                        }).lean();
                        const upstoxToken = angelToken?.jwtToken ? null : await UpstoxTokensModel.findOne({
                            userId: u._id,
                            expiresAt: { $gt: now }
                        }).lean() as any;
                        base.broker_session_active = !!(angelToken?.jwtToken || upstoxToken?.accessToken);
                    } catch (_e) {
                        base.broker_session_active = false;
                    }
                }
                return base;
            })
        );

        res.status(200).json({
            message: "Users fetched successfully!",
            count: users.length,
            data: enrichedUsers,
            status: true,
        });

    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const getUserSearch = async (req: Request, res: Response) => {
    try {
        const { name, user_name, full_name, phone_number, mobile_number } = req.query;

        const nameTerm = (user_name || full_name || name || "").toString().trim();
        const phoneTerm = (phone_number || mobile_number || "").toString().trim();

        let query: any = {};

        if (nameTerm) {
            query.$or = [
                { user_name: { $regex: nameTerm, $options: 'i' } },
                { full_name: { $regex: nameTerm, $options: 'i' } }
            ];
        }

        if (phoneTerm) {
            query.phone_number = { $regex: phoneTerm, $options: 'i' };
        }

        const actor = (req as any).user;
        if (actor && (actor.role === 'sub-admin' || actor.role === 'subadmin')) {
            if (!actor.all_permission) {
                query.sub_admin = actor.full_name;
            }
        }

        const users = await User.find(query).select("-password");
        const maskedUsers = users.map((u) => ({
            ...u.toObject(),
            client_key: maskKey(u.client_key || ""),
            api_key: maskKey(u.api_key || ""),
        }));
        res.status(200).json({
            users: maskedUsers,
            total_users: users.length,
            status: true,
        });

    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const verifyUserBroker = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { verified } = req.body;

        if (!verified) {
            await User.updateOne({ _id: id }, { broker_verified: false, broker_connected: false });
            return res.status(200).json({ message: "Broker unverified successfully!", status: true });
        }

        const user = await User.findById(id);
        if (!user) return res.status(404).json({ error: "User not found", status: false });

        if (!user.client_key || !user.api_key) {
            return res.status(400).json({ error: "Broker API Key or Client Code missing.", status: false });
        }

        const client_code = decrypt(user.client_key);
        const tokenData = await AngelTokensModel.findOne({
            userId: user._id,
            clientcode: client_code,
        });

        if (!tokenData || !tokenData.jwtToken) {
            return res.status(400).json({
                error: "Access token missing or expired. User MUST login to Angel One dashboard again.",
                status: false
            });
        }

        const profile = await executeWithSessionRecovery(
            {
                userId: String(user._id),
                clientcode: client_code,
                purpose: "user_broker_validate",
            },
            (session) => session.adapter.getProfile(session.jwtToken)
        );

        if (profile && profile.status === 200) {
            user.broker_verified = true;
            user.broker_connected = true;
            await user.save();

            return res.status(200).json({
                message: "Broker connection verified and connected successfully!",
                status: true,
                data: { broker_verified: true, broker_connected: true }
            });
        } else {
            user.broker_connected = false;
            await user.save();
            return res.status(401).json({
                error: "Broker validation failed (Profile API error). User needs to re-login to Angel One.",
                status: false
            });
        }
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
};

export const toggleStarClient = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const user = await User.findById(id);
        if (!user) return res.status(404).json({ error: "User not found", status: false });

        user.is_star = !user.is_star;
        await user.save();

        res.status(200).json({
            message: `Client ${user.is_star ? 'added to' : 'removed from'} favorites`,
            is_star: user.is_star,
            status: true
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
};

export const getBrokerSessionStatus = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const user = await User.findById(id).select('-password');
        if (!user) return res.status(404).json({ error: 'User not found', status: false });

        if (user.licence !== 'Live') {
            return res.status(200).json({
                status: true,
                broker_session_active: false,
                reason: 'DEMO_USER',
                message: 'Demo users do not have broker sessions.'
            });
        }

        if (!user.client_key) {
            return res.status(200).json({
                status: true,
                broker_session_active: false,
                reason: 'NO_CLIENT_CODE',
                message: 'No broker client code configured for this user.'
            });
        }

        const clientcode = decrypt(user.client_key);
        const now = new Date();

        const angelToken = await AngelTokensModel.findOne({
            userId: user._id,
            clientcode,
            expiresAt: { $gt: now }
        }).lean() as any;

        if (angelToken?.jwtToken) {
            return res.status(200).json({
                status: true,
                broker_session_active: true,
                broker: 'AngelOne',
                reason: 'SESSION_FOUND',
                message: 'Active AngelOne session found.',
                session_created_at: angelToken.updatedAt || angelToken.createdAt
            });
        }

        const upstoxToken = await UpstoxTokensModel.findOne({
            userId: user._id,
            expiresAt: { $gt: now }
        }).lean() as any;

        if (upstoxToken?.accessToken) {
            return res.status(200).json({
                status: true,
                broker_session_active: true,
                broker: 'Upstox',
                reason: 'SESSION_FOUND',
                message: 'Active Upstox session found.',
                session_created_at: upstoxToken.updatedAt || upstoxToken.createdAt
            });
        }

        return res.status(200).json({
            status: true,
            broker_session_active: false,
            reason: 'NO_SESSION',
            message: 'No active broker session. User must login to their broker account.'
        });

    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
};

export const updateLotMultipliers = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { lot_multipliers } = req.body;

        await User.updateOne({ _id: id }, { lot_multipliers });
        const updatedUser = await User.findById(id);
        if (!updatedUser) return res.status(404).json({ error: "User not found", status: false });

        res.status(200).json({
            message: "Lot Multipliers updated successfully!",
            data: updatedUser.lot_multipliers,
            status: true
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
};

export const getRiskStatus = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { refresh } = req.query;
        const user = await User.findById(id);
        if (!user) return res.status(404).json({ error: 'User not found', status: false });

        const clientcode = decrypt(user.client_key || "");

        const { ProfileValidationService } = require('../services/ProfileValidationService');
        const { RiskManagementService } = require('../services/RiskManagementService');

        if (refresh === 'true') {
            ProfileValidationService.clearCache(user._id.toString(), clientcode);
        }

        const profile = await ProfileValidationService.validateUserSession(user._id.toString(), clientcode);
        const margin = await RiskManagementService.getAvailableMargin(user._id.toString(), clientcode);

        res.status(200).json({
            status: true,
            data: {
                user_name: user.user_name,
                full_name: user.full_name,
                licence: user.licence,
                trading_paused: user.trading_paused || false,
                consecutive_failures: user.consecutive_failures || 0,
                profile_valid: profile.status,
                profile_message: profile.message,
                margin_valid: margin.status,
                margin_data: margin.data,
                margin_message: margin.message,
                risk_limit: 0.7
            }
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
};
export const reactivateTrading = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        
        // Find user first to ensure it exists
        const user = await User.findById(id);
        if (!user) return res.status(404).json({ error: "User not found", status: false });

        // Reset both paused flag and consecutive failures
        user.trading_paused = false;
        user.consecutive_failures = 0;
        await user.save();

        res.status(200).json({
            message: "Trading reactivated successfully! You can now resume algo trading.",
            status: true,
            data: { trading_paused: false, consecutive_failures: 0 }
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
};

export const startTradingDay = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const user = await User.findById(id);
        if (!user) return res.status(404).json({ error: 'User not found', status: false });

        const clientcode = decrypt(user.client_key || "");
        
        // 1. Check broker token presence and expiry
        const now = new Date();
        const angelToken = await AngelTokensModel.findOne({
            userId: user._id,
            clientcode,
            expiresAt: { $gt: now }
        }).lean();

        if (!angelToken || !angelToken.jwtToken) {
            return res.status(200).json({
                status: true,
                sessionState: "PENDING_AUTH",
                message: "No active broker session found. Please authenticate with your broker.",
            });
        }

        // 2. Validate session and retrieve margin
        const { ProfileValidationService } = require('../services/ProfileValidationService');
        const { RiskManagementService } = require('../services/RiskManagementService');
        
        const profile = await ProfileValidationService.validateUserSession(user._id.toString(), clientcode);
        if (!profile.status) {
            return res.status(200).json({
                status: true,
                sessionState: "EXPIRED",
                message: `Broker session invalid: ${profile.message}. Please login again.`,
            });
        }

        const margin = await RiskManagementService.getAvailableMargin(user._id.toString(), clientcode);

        // 3. Check system startup diagnostics and circuit breakers
        const { StartupDiagnostics } = require('../utils/startupDiagnostics');
        const { clockDriftMonitor } = require('../services/ClockDriftMonitor');

        let sessionState = "AUTHORIZED";
        let message = "Trading Day started successfully! Algo execution is fully authorized.";

        if (StartupDiagnostics.isSafeBootMode()) {
            sessionState = "SAFE_MODE";
            message = "System is running under SAFE_BOOT_MODE. Only paper trading and exits are allowed.";
        } else if (!clockDriftMonitor.isEntryAllowed()) {
            sessionState = "READ_ONLY_MODE";
            message = `System is running in READ_ONLY_MODE due to clock drift: ${clockDriftMonitor.getSafetyMode()}. Entries are suspended.`;
        }

        res.status(200).json({
            status: true,
            sessionState,
            message,
            data: {
                user_name: user.user_name,
                trading_paused: user.trading_paused || false,
                profile_valid: profile.status,
                margin_valid: margin.status,
                margin_data: margin.data,
            }
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
};

