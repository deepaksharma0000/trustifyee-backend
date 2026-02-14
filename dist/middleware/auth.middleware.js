"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminOnly = exports.auth = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const dotenv_1 = __importDefault(require("dotenv"));
const User_1 = __importDefault(require("../models/User"));
const Admin_1 = __importDefault(require("../models/Admin"));
dotenv_1.default.config();
const ACCESS_SECRET = process.env.accessSecret || 'access_secret_key_123';
const auth = async (req, res, next) => {
    try {
        const authHeader = req.header("authorization");
        const bearerToken = authHeader?.startsWith("Bearer ")
            ? authHeader.slice(7).trim()
            : undefined;
        const access = bearerToken || req.header("x-access-token");
        if (!access) {
            return res.status(401).json({ error: "Access token is missing" });
        }
        const decoded = jsonwebtoken_1.default.verify(access, ACCESS_SECRET);
        if (!decoded || !decoded.user_id) {
            return res.status(403).json({ error: "Invalid token payload" });
        }
        // Check in User model first
        let user = await User_1.default.findById(decoded.user_id);
        if (!user) {
            // Check in Admin model
            user = await Admin_1.default.findById(decoded.user_id);
        }
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }
        // Phase 1: Check account status and 15-day Demo grace period
        if (user.status === 'inactive') {
            return res.status(403).json({ error: "Account disabled. Please contact admin." });
        }
        if (user.licence === 'Demo' && user.end_date) {
            const today = new Date();
            const expiryDate = new Date(user.end_date);
            const disableDate = new Date(expiryDate);
            disableDate.setDate(expiryDate.getDate() + 15);
            if (today > disableDate) {
                user.status = 'inactive';
                await user.save();
                return res.status(403).json({ error: "Demo grace period expired. Account disabled." });
            }
        }
        req.id = decoded.user_id;
        req.user = user;
        req.userType = user?.role ? 'admin' : 'user';
        next();
    }
    catch (error) {
        console.error("Auth Error:", error);
        if (error.name === "TokenExpiredError") {
            return res.status(401).json({ error: "Access token has expired!" });
        }
        else if (error.name === "JsonWebTokenError") {
            return res.status(403).json({ error: "Invalid access token" });
        }
        else {
            return res.status(500).json({ error: "Internal server error" });
        }
    }
};
exports.auth = auth;
const adminOnly = (req, res, next) => {
    const role = req.user?.role;
    if (role !== 'admin') {
        return res.status(403).json({ error: "Admin access required" });
    }
    return next();
};
exports.adminOnly = adminOnly;
