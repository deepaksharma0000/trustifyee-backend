"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logoutUser = exports.logoutAdmin = exports.loginUser = exports.registerUser = exports.loginAdmin = exports.registerAdmin = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const joi_1 = __importDefault(require("joi"));
const User_1 = __importDefault(require("../models/User"));
const Admin_1 = __importDefault(require("../models/Admin"));
const tokens_1 = require("../utils/tokens");
const functions_1 = require("../utils/functions");
const uuid_1 = require("uuid");
// Schemas
const adminRegisterSchema = joi_1.default.object({
    full_name: joi_1.default.string().min(3).max(150).required(),
    mobile: joi_1.default.string().pattern(/^[0-9]{10,15}$/).required(),
    email: joi_1.default.string().email().required(),
    password: joi_1.default.string().min(6).optional(),
    panel_client_key: joi_1.default.string().min(3).required(),
    role: joi_1.default.string().valid("admin", "sub-admin").default("sub-admin"),
    status: joi_1.default.string().valid("active", "inactive").default("active"),
    // Permissions
    all_permission: joi_1.default.boolean().default(false),
    add_client: joi_1.default.boolean().default(false),
    edit_client: joi_1.default.boolean().default(false),
    licence_permission: joi_1.default.boolean().default(false),
    go_to_dashboard: joi_1.default.boolean().default(false),
    trade_history: joi_1.default.boolean().default(false),
    full_info_view: joi_1.default.boolean().default(false),
    update_client_api_key: joi_1.default.boolean().default(false),
    strategy_permission: joi_1.default.boolean().default(false),
    group_service_permission: joi_1.default.boolean().default(false),
});
const userRegisterSchema = joi_1.default.object({
    user_name: joi_1.default.string().required(),
    email: joi_1.default.string().email().required(),
    full_name: joi_1.default.string().required(),
    phone_number: joi_1.default.string().required(),
    password: joi_1.default.string().min(6).optional(),
    // Optional fields
    client_key: joi_1.default.string().optional(),
    broker: joi_1.default.string().allow('', null),
    status: joi_1.default.string().valid('active', 'inactive').default('active'),
    trading_status: joi_1.default.string().valid('enabled', 'disabled').default('enabled'),
    start_date: joi_1.default.date().optional(),
    end_date: joi_1.default.date().optional(),
    licence: joi_1.default.string().valid('Live', 'Demo').default('Live'),
    to_month: joi_1.default.string().allow('', null),
    sub_admin: joi_1.default.string().allow('', null),
    service_to_month: joi_1.default.string().allow('', null),
    group_service: joi_1.default.string().allow('', null),
});
const registerAdmin = async (req, res) => {
    try {
        const { error } = adminRegisterSchema.validate(req.body);
        if (error)
            return res.status(400).json({ error: error.message, status: false });
        const { email, mobile, panel_client_key, password } = req.body;
        const existingEmail = await Admin_1.default.findOne({ email });
        if (existingEmail)
            return res.status(400).json({ error: "Admin email already exists.", status: false });
        const existingMobile = await Admin_1.default.findOne({ mobile });
        if (existingMobile)
            return res.status(400).json({ error: "Mobile number already exists.", status: false });
        const existingKey = await Admin_1.default.findOne({ panel_client_key });
        if (existingKey)
            return res.status(400).json({ error: "Panel client key already exists.", status: false });
        const hashedPassword = await bcryptjs_1.default.hash(password, 10);
        const newAdmin = new Admin_1.default({
            ...req.body,
            password: hashedPassword
        });
        await newAdmin.save();
        const accessToken = (0, tokens_1.generateAccessToken)(newAdmin._id);
        const refreshToken = (0, tokens_1.generateRefreshToken)(newAdmin._id);
        res.status(201).json({
            message: "Admin registration successful!",
            data: newAdmin,
            status: true,
            access: { token: accessToken, issued_at: new Date() },
            refresh: { token: refreshToken, issued_at: new Date() },
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.registerAdmin = registerAdmin;
const loginAdmin = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !(0, functions_1.validateEmail)(email))
            return res.status(400).json({ error: "Email is not valid", status: false });
        if (!password)
            return res.status(400).json({ error: "Password is required", status: false });
        const admin = await Admin_1.default.findOne({ email });
        if (!admin)
            return res.status(404).json({ error: "Admin does not exist.", status: false });
        const isMatch = await bcryptjs_1.default.compare(password, admin.password);
        if (!isMatch)
            return res.status(400).json({ error: "Invalid password", status: false });
        admin.is_login = true;
        await admin.save();
        const accessToken = (0, tokens_1.generateAccessToken)(admin._id);
        const refreshToken = (0, tokens_1.generateRefreshToken)(admin._id);
        res.status(200).json({
            message: "Login successful!",
            data: admin,
            status: true,
            access: { token: accessToken, issued_at: new Date() },
            refresh: { token: refreshToken, issued_at: new Date() },
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.loginAdmin = loginAdmin;
const registerUser = async (req, res) => {
    try {
        const { error } = userRegisterSchema.validate(req.body);
        if (error)
            return res.status(400).json({ error: error.message, status: false });
        const { email, phone_number, user_name } = req.body;
        const existingUser = await User_1.default.findOne({ $or: [{ email }, { phone_number }] });
        if (existingUser)
            return res.status(400).json({ error: "Email or phone exists.", status: false });
        const plainPassword = user_name.substring(0, 4).toLowerCase() + '@123';
        const hashedPassword = await bcryptjs_1.default.hash(plainPassword, 10);
        const client_key = req.body.client_key || (0, uuid_1.v4)();
        const newUser = new User_1.default({
            ...req.body,
            client_key,
            password: hashedPassword
        });
        await newUser.save();
        res.status(201).json({
            message: "User registration successful!",
            data: newUser,
            status: true
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.registerUser = registerUser;
const loginUser = async (req, res) => {
    try {
        const { user_name, password } = req.body;
        if (!user_name)
            return res.status(400).json({ error: "User name is required", status: false });
        if (!password)
            return res.status(400).json({ error: "Password is required", status: false });
        const user = await User_1.default.findOne({ user_name });
        if (!user)
            return res.status(404).json({ error: "User does not exist.", status: false });
        const isMatch = await bcryptjs_1.default.compare(password, user.password);
        if (!isMatch)
            return res.status(400).json({ error: "Invalid password", status: false });
        user.is_login = true;
        await user.save();
        const accessToken = (0, tokens_1.generateAccessToken)(user._id);
        const refreshToken = (0, tokens_1.generateRefreshToken)(user._id);
        res.status(200).json({
            message: "Login successful!",
            data: user,
            status: true,
            access: { token: accessToken, issued_at: new Date() },
            refresh: { token: refreshToken, issued_at: new Date() },
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.loginUser = loginUser;
const logoutAdmin = async (req, res) => {
    try {
        const adminId = req.id;
        if (!adminId)
            return res.status(401).json({ error: "Unauthorized", status: false });
        await Admin_1.default.findByIdAndUpdate(adminId, { is_login: false });
        res.status(200).json({
            message: "Admin logged out successfully!",
            status: true
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.logoutAdmin = logoutAdmin;
const logoutUser = async (req, res) => {
    try {
        const userId = req.id;
        if (!userId)
            return res.status(401).json({ error: "Unauthorized", status: false });
        await User_1.default.findByIdAndUpdate(userId, { is_login: false });
        res.status(200).json({
            message: "User logged out successfully!",
            status: true
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.logoutUser = logoutUser;
