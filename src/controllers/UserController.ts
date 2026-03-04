import { Request, Response } from 'express';
import User from '../models/User';
import Joi from 'joi';
import bcrypt from 'bcryptjs';
import { encrypt, maskKey, decrypt } from '../utils/encryption';
import { AngelOneAdapter } from '../adapters/AngelOneAdapter';
import AngelTokensModel from '../models/AngelTokens';
import UpstoxTokensModel from '../models/UpstoxTokens';

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
    is_online: Joi.boolean().optional(),
    is_login: Joi.boolean().optional(),
    is_star: Joi.boolean().optional(),
}).unknown(true);

export const updateUser = async (req: any, res: Response) => {
    try {
        const { id } = req.params;
        const { error, value } = updateUserSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.message, status: false });

        const userToUpdate = await User.findById(id);
        if (!userToUpdate) return res.status(404).json({ error: "User not found", status: false });

        const updateData: any = { ...value };
        const actor = (req as any).user; // The Admin or Sub-Admin making the request
        if (!actor) return res.status(401).json({ error: "Unauthorized: Actor not identified.", status: false });

        // [CRITICAL] Backend Guard: NEVER allow these fields via general profile update
        delete updateData.password;
        delete updateData.email;
        delete updateData.user_name;
        delete updateData.client_key;
        delete updateData.api_key;
        delete updateData.broker_verified;

        // [PRODUCTION READY] Granular Permission Enforcement for Sub-Admins
        if (actor.role === 'sub-admin' || actor.role === 'subadmin') {
            if (!actor.all_permission) {
                console.log(`[ACL] Checking permissions for ${actor.full_name} on user ${id}`);

                // Check Licence change
                if (updateData.licence !== undefined && updateData.licence !== userToUpdate.licence && !actor.licence_permission) {
                    return res.status(403).json({ error: "Access Denied: You do not have permission to change Licence (Live/Demo)", status: false });
                }
                // Check Strategies change
                const stratChanged = updateData.strategies !== undefined && JSON.stringify(updateData.strategies) !== JSON.stringify(userToUpdate.strategies);
                if (stratChanged && !actor.strategy_permission) {
                    return res.status(403).json({ error: "Access Denied: You do not have permission to change Strategies", status: false });
                }
                // Check Group Service change
                if (updateData.group_service !== undefined && updateData.group_service !== userToUpdate.group_service && !actor.group_service_permission) {
                    return res.status(403).json({ error: "Access Denied: You do not have permission to change Group Services", status: false });
                }
            }
        }

        const updatedUser = await User.findByIdAndUpdate(id, updateData, { new: true });
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
        const { client_key, api_key } = req.body;

        const updateData: any = {};
        if (client_key) updateData.client_key = encrypt(client_key);
        if (api_key) updateData.api_key = encrypt(api_key);

        // Reset verification status whenever broker details change
        updateData.broker_verified = false;
        updateData.broker_connected = false;

        const updatedUser = await User.findByIdAndUpdate(id, updateData, { new: true });
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
            // Include up to the end of the specified date
            const customDate = new Date(date as string);
            customDate.setHours(23, 59, 59, 999);
            query.end_date = { $lte: customDate };
        }

        // [PRODUCTION READY] Sub-Admin Client Isolation
        const actor = (req as any).user;
        if (actor && (actor.role === 'sub-admin' || actor.role === 'subadmin')) {
            if (!actor.all_permission) {
                // Only show clients assigned to this particular Sub-Admin
                query.sub_admin = actor.full_name;
            }
        }

        console.log(`[getUsersByEndDate] Final Query:`, JSON.stringify(query));

        const users = await User.find(query).select("-password");

        console.log(`[getUsersByEndDate] Found ${users.length} users for actor: ${actor?.full_name}`);

        // 🔥 [NEW] Enrich each user with live broker session status
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
        console.error(`[getUsersByEndDate] Error:`, err);
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

        // [PRODUCTION READY] Sub-Admin Client Isolation for Search
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
            await User.findByIdAndUpdate(id, { broker_verified: false, broker_connected: false });
            return res.status(200).json({ message: "Broker unverified successfully!", status: true });
        }

        const user = await User.findById(id);
        if (!user) return res.status(404).json({ error: "User not found", status: false });

        // [STEP 1] Check if keys exist
        if (!user.client_key || !user.api_key) {
            return res.status(400).json({ error: "Broker API Key or Client Code missing.", status: false });
        }

        // [STEP 2] Check for an active session (Access Token)
        const client_code = decrypt(user.client_key);
        const now = new Date();
        const tokenData = await AngelTokensModel.findOne({
            userId: user._id,
            clientcode: client_code,
            expiresAt: { $gt: now }
        });

        if (!tokenData || !tokenData.jwtToken) {
            return res.status(400).json({
                error: "Access token missing or expired. User MUST login to Angel One dashboard again.",
                status: false
            });
        }

        // [STEP 3] Call Test API (Get Profile)
        const adapter = new AngelOneAdapter();
        const profile = await adapter.getProfile(tokenData.jwtToken);

        if (profile && profile.status === true) {
            user.broker_verified = true;
            user.broker_connected = true; // Unlock
            await user.save();

            return res.status(200).json({
                message: "Broker connection verified and connected successfully!",
                status: true,
                data: { broker_verified: true, broker_connected: true }
            });
        } else {
            // Success toggle failed because API rejected it
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
}

// [NEW] GET /api/user/broker-session-status/:id
// Admin checks if a specific user has an active broker session
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

        // Check AngelOne
        const angelToken = await AngelTokensModel.findOne({
            userId: user._id,
            clientcode,
            expiresAt: { $gt: now }
        }).lean();
        if (angelToken?.jwtToken) {
            return res.status(200).json({
                status: true,
                broker_session_active: true,
                broker: 'AngelOne',
                reason: 'SESSION_FOUND',
                message: 'Active AngelOne session found.',
                session_created_at: (angelToken as any).updatedAt || (angelToken as any).createdAt
            });
        }

        // Check Upstox
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
