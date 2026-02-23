"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminOnly = exports.auth = exports.adminAuth = exports.userAuth = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const dotenv_1 = __importDefault(require("dotenv"));
const User_1 = __importDefault(require("../models/User"));
const Admin_1 = __importDefault(require("../models/Admin"));
dotenv_1.default.config();
const USER_ACCESS_SECRET = process.env.USER_ACCESS_SECRET || 'user_access_secret_123';
const ADMIN_ACCESS_SECRET = process.env.ADMIN_ACCESS_SECRET || 'admin_access_secret_123';
const commonAuth = async (req, res, next, secret, model, type) => {
    try {
        const authHeader = req.header("authorization");
        const bearerToken = authHeader?.startsWith("Bearer ")
            ? authHeader.slice(7).trim()
            : undefined;
        const access = bearerToken || req.header("x-access-token") || req.query.token;
        if (!access) {
            return res.status(401).json({ error: "Access token is missing" });
        }
        const decoded = jsonwebtoken_1.default.verify(access, secret);
        if (!decoded || !decoded.user_id) {
            return res.status(403).json({ error: "Invalid token payload" });
        }
        const user = await model.findById(decoded.user_id);
        if (!user) {
            return res.status(404).json({ error: `${type === 'admin' ? 'Admin' : 'User'} not found` });
        }
        if (user.status === 'inactive') {
            return res.status(403).json({ error: "Account disabled. Please contact admin." });
        }
        if (type === 'user' && user.licence === 'Demo' && user.end_date) {
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
        req.userType = type;
        next();
    }
    catch (error) {
        console.error(`${type.toUpperCase()} Auth Error:`, error);
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
const userAuth = (req, res, next) => {
    return commonAuth(req, res, next, USER_ACCESS_SECRET, User_1.default, 'user');
};
exports.userAuth = userAuth;
const adminAuth = (req, res, next) => {
    return commonAuth(req, res, next, ADMIN_ACCESS_SECRET, Admin_1.default, 'admin');
};
exports.adminAuth = adminAuth;
// Legacy support if needed, but should be avoided for strict isolation
const auth = async (req, res, next) => {
    try {
        const authHeader = req.header("authorization");
        const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
        const access = bearerToken || req.header("x-access-token") || req.query.token;
        if (!access)
            return res.status(401).json({ error: "Access token is missing" });
        // Try Admin secret first
        try {
            const decoded = jsonwebtoken_1.default.verify(access, ADMIN_ACCESS_SECRET);
            const admin = await Admin_1.default.findById(decoded.user_id);
            if (admin) {
                req.id = decoded.user_id;
                req.user = admin;
                req.userType = 'admin';
                return next();
            }
        }
        catch (e) { }
        // Then try User secret
        const decoded = jsonwebtoken_1.default.verify(access, USER_ACCESS_SECRET);
        const user = await User_1.default.findById(decoded.user_id);
        if (user) {
            req.id = decoded.user_id;
            req.user = user;
            req.userType = 'user';
            return next();
        }
        return res.status(404).json({ error: "User or Admin not found" });
    }
    catch (error) {
        return res.status(403).json({ error: "Invalid or expired token" });
    }
};
exports.auth = auth;
const adminOnly = (req, res, next) => {
    if (req.userType !== 'admin') {
        return res.status(403).json({ error: "Admin access required" });
    }
    return next();
};
exports.adminOnly = adminOnly;
