"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.auth = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const dotenv_1 = __importDefault(require("dotenv"));
const User_1 = __importDefault(require("../models/User"));
const Admin_1 = __importDefault(require("../models/Admin"));
dotenv_1.default.config();
const ACCESS_SECRET = process.env.accessSecret || 'access_secret_key_123';
const auth = async (req, res, next) => {
    try {
        const access = req.header("x-access-token");
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
        req.id = decoded.user_id;
        req.user = user;
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
