"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserSearch = exports.getUsersByEndDate = exports.getUserTotalCount = exports.getLoggedInUsers = exports.deleteUser = exports.updateUser = void 0;
const User_1 = __importDefault(require("../models/User"));
const joi_1 = __importDefault(require("joi"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const updateUserSchema = joi_1.default.object({
    user_name: joi_1.default.string().optional(),
    email: joi_1.default.string().email().optional(),
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
    password: joi_1.default.string().min(6).optional(),
    strategies: joi_1.default.array().items(joi_1.default.string()).optional(),
    api_key: joi_1.default.string().allow('', null).optional(),
    client_key: joi_1.default.string().allow('', null).optional(),
});
const updateUser = async (req, res) => {
    try {
        const { id } = req.params;
        const { error, value } = updateUserSchema.validate(req.body);
        if (error)
            return res.status(400).json({ error: error.message, status: false });
        const updateData = { ...value };
        if (updateData.client_key === "") {
            delete updateData.client_key;
        }
        if (updateData.api_key === "") {
            delete updateData.api_key;
        }
        if (updateData.password) {
            updateData.password = await bcryptjs_1.default.hash(updateData.password, 10);
        }
        const updatedUser = await User_1.default.findByIdAndUpdate(id, updateData, { new: true });
        if (!updatedUser)
            return res.status(404).json({ error: "User not found", status: false });
        res.status(200).json({
            message: "User updated successfully!",
            data: updatedUser,
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
        const users = await User_1.default.find({ is_login: true });
        res.status(200).json({
            message: "Logged-in users fetched successfully!",
            count: users.length,
            data: users,
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
        const users = await User_1.default.find(query);
        res.status(200).json({
            message: "Users fetched successfully!",
            count: users.length,
            data: users,
            status: true
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
        const users = await User_1.default.find(query);
        res.status(200).json({
            users,
            total_users: users.length,
            status: true
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.getUserSearch = getUserSearch;
