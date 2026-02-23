"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyUserBroker = exports.getUserSearch = exports.getUsersByEndDate = exports.getUserTotalCount = exports.getLoggedInUsers = exports.deleteUser = exports.updateUserBroker = exports.updateUser = void 0;
const User_1 = __importDefault(require("../models/User"));
const joi_1 = __importDefault(require("joi"));
const encryption_1 = require("../utils/encryption");
const AngelOneAdapter_1 = require("../adapters/AngelOneAdapter");
const AngelTokens_1 = __importDefault(require("../models/AngelTokens"));
const updateUserSchema = joi_1.default.object({
    full_name: joi_1.default.string().optional(),
    phone_number: joi_1.default.string().optional(),
    broker: joi_1.default.string().allow('', null).optional(),
    status: joi_1.default.string().valid('active', 'inactive').optional(),
    trading_status: joi_1.default.string().valid('enabled', 'disabled').optional(),
    start_date: joi_1.default.date().optional(),
    end_date: joi_1.default.date().optional(),
    licence: joi_1.default.string().valid('Live', 'Demo').optional(),
    to_month: joi_1.default.string().allow('', null).optional(),
    sub_admin: joi_1.default.string().allow('', null).optional(),
    service_to_month: joi_1.default.string().allow('', null).optional(),
    group_service: joi_1.default.string().allow('', null).optional(),
    strategies: joi_1.default.array().items(joi_1.default.string()).optional(),
    is_online: joi_1.default.boolean().optional(),
    is_login: joi_1.default.boolean().optional(),
}).unknown(true);
const updateUser = async (req, res) => {
    try {
        const { id } = req.params;
        const { error, value } = updateUserSchema.validate(req.body);
        if (error)
            return res.status(400).json({ error: error.message, status: false });
        const updateData = { ...value };
        // [CRITICAL] Backend Guard: NEVER allow these fields via general profile update
        delete updateData.password;
        delete updateData.email;
        delete updateData.user_name;
        delete updateData.client_key;
        delete updateData.api_key;
        delete updateData.broker_verified;
        const updatedUser = await User_1.default.findByIdAndUpdate(id, updateData, { new: true });
        if (!updatedUser)
            return res.status(404).json({ error: "User not found", status: false });
        const maskedUpdatedUser = {
            ...updatedUser.toObject(),
            client_key: (0, encryption_1.maskKey)(updatedUser.client_key || ""),
            api_key: (0, encryption_1.maskKey)(updatedUser.api_key || "")
        };
        res.status(200).json({
            message: "Profile updated successfully!",
            data: maskedUpdatedUser,
            status: true
        });
    }
    catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ error: "Duplicate error", status: false });
        }
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.updateUser = updateUser;
const updateUserBroker = async (req, res) => {
    try {
        const { id } = req.params;
        const { client_key, api_key } = req.body;
        const updateData = {};
        if (client_key)
            updateData.client_key = (0, encryption_1.encrypt)(client_key);
        if (api_key)
            updateData.api_key = (0, encryption_1.encrypt)(api_key);
        // Reset verification status whenever broker details change
        updateData.broker_verified = false;
        updateData.broker_connected = false;
        const updatedUser = await User_1.default.findByIdAndUpdate(id, updateData, { new: true });
        if (!updatedUser)
            return res.status(404).json({ error: "User not found", status: false });
        res.status(200).json({
            message: "Broker details updated successfully! Pending admin approval.",
            status: true
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.updateUserBroker = updateUserBroker;
const deleteUser = async (req, res) => {
    try {
        const { id } = req.params;
        const deleted = await User_1.default.findByIdAndDelete(id);
        if (!deleted)
            return res.status(404).json({ message: "User not found", status: false });
        res.status(200).json({ message: "User deleted successfully!", status: true });
    }
    catch (err) {
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.deleteUser = deleteUser;
const getLoggedInUsers = async (req, res) => {
    try {
        const users = await User_1.default.find({ is_login: true }).select('-password');
        const maskedUsers = users.map(u => ({
            ...u.toObject(),
            client_key: (0, encryption_1.maskKey)(u.client_key || ""),
            api_key: (0, encryption_1.maskKey)(u.api_key || "")
        }));
        res.status(200).json({
            message: "Logged-in users fetched successfully!",
            count: users.length,
            data: maskedUsers,
            status: true
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.getLoggedInUsers = getLoggedInUsers;
const getUserTotalCount = async (req, res) => {
    try {
        const count = await User_1.default.countDocuments();
        res.status(200).json({ total_users: count, status: true });
    }
    catch (err) {
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.getUserTotalCount = getUserTotalCount;
const getUsersByEndDate = async (req, res) => {
    try {
        const { filter, date } = req.query;
        let query = {};
        const today = new Date();
        if (filter === "expired") {
            query.end_date = { $lt: today };
        }
        else if (filter === "active") {
            query.end_date = { $gte: today };
        }
        else if (filter === "custom" && date) {
            query.end_date = { $lte: new Date(date) };
        }
        const users = await User_1.default.find(query).select("-password");
        const maskedUsers = users.map((u) => ({
            ...u.toObject(),
            client_key: (0, encryption_1.maskKey)(u.client_key || ""),
            api_key: (0, encryption_1.maskKey)(u.api_key || ""),
        }));
        res.status(200).json({
            message: "Users fetched successfully!",
            count: users.length,
            data: maskedUsers,
            status: true,
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.getUsersByEndDate = getUsersByEndDate;
const getUserSearch = async (req, res) => {
    try {
        const { name, user_name, full_name, phone_number, mobile_number } = req.query;
        const nameTerm = (user_name || full_name || name || "").toString().trim();
        const phoneTerm = (phone_number || mobile_number || "").toString().trim();
        let query = {};
        if (nameTerm) {
            query.$or = [
                { user_name: { $regex: nameTerm, $options: 'i' } },
                { full_name: { $regex: nameTerm, $options: 'i' } }
            ];
        }
        if (phoneTerm) {
            query.phone_number = { $regex: phoneTerm, $options: 'i' };
        }
        const users = await User_1.default.find(query).select("-password");
        const maskedUsers = users.map((u) => ({
            ...u.toObject(),
            client_key: (0, encryption_1.maskKey)(u.client_key || ""),
            api_key: (0, encryption_1.maskKey)(u.api_key || ""),
        }));
        res.status(200).json({
            users: maskedUsers,
            total_users: users.length,
            status: true,
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.getUserSearch = getUserSearch;
const verifyUserBroker = async (req, res) => {
    try {
        const { id } = req.params;
        const { verified } = req.body;
        if (!verified) {
            await User_1.default.findByIdAndUpdate(id, { broker_verified: false, broker_connected: false });
            return res.status(200).json({ message: "Broker unverified successfully!", status: true });
        }
        const user = await User_1.default.findById(id);
        if (!user)
            return res.status(404).json({ error: "User not found", status: false });
        // [STEP 1] Check if keys exist
        if (!user.client_key || !user.api_key) {
            return res.status(400).json({ error: "Broker API Key or Client Code missing.", status: false });
        }
        // [STEP 2] Check for an active session (Access Token)
        const client_code = (0, encryption_1.decrypt)(user.client_key);
        const tokenData = await AngelTokens_1.default.findOne({ userId: user._id, clientcode: client_code });
        if (!tokenData || !tokenData.jwtToken) {
            return res.status(400).json({
                error: "Access token missing. User MUST login to Angel One dashboard first to generate a session.",
                status: false
            });
        }
        // [STEP 3] Call Test API (Get Profile)
        const adapter = new AngelOneAdapter_1.AngelOneAdapter();
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
        }
        else {
            // Success toggle failed because API rejected it
            user.broker_connected = false;
            await user.save();
            return res.status(401).json({
                error: "Broker validation failed (Profile API error). User needs to re-login to Angel One.",
                status: false
            });
        }
    }
    catch (err) {
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.verifyUserBroker = verifyUserBroker;
