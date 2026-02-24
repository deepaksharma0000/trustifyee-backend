import { Request, Response } from 'express';
import User from '../models/User';
import Joi from 'joi';
import bcrypt from 'bcryptjs';
import { encrypt, maskKey, decrypt } from '../utils/encryption';
import { AngelOneAdapter } from '../adapters/AngelOneAdapter';
import AngelTokensModel from '../models/AngelTokens';

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
}).unknown(true);

export const updateUser = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { error, value } = updateUserSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.message, status: false });

        const updateData: any = { ...value };

        // [CRITICAL] Backend Guard: NEVER allow these fields via general profile update
        delete updateData.password;
        delete updateData.email;
        delete updateData.user_name;
        delete updateData.client_key;
        delete updateData.api_key;
        delete updateData.broker_verified;

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
        const users = await User.find({ is_login: true }).select('-password');
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

        console.log(`[getUsersByEndDate] Final Query:`, JSON.stringify(query));

        const users = await User.find(query).select("-password");

        console.log(`[getUsersByEndDate] Found ${users.length} users`);

        const maskedUsers = users.map((u) => ({
            ...u.toObject(),
            client_key: maskKey(u.client_key || ""),
            api_key: maskKey(u.api_key || ""),
        }));

        res.status(200).json({
            message: "Users fetched successfully!",
            count: users.length,
            data: maskedUsers,
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
        const tokenData = await AngelTokensModel.findOne({ userId: user._id, clientcode: client_code });

        if (!tokenData || !tokenData.jwtToken) {
            return res.status(400).json({
                error: "Access token missing. User MUST login to Angel One dashboard first to generate a session.",
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
