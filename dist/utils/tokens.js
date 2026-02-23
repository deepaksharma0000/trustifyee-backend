"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateRefreshToken = exports.generateAccessToken = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const USER_ACCESS_SECRET = process.env.USER_ACCESS_SECRET || 'user_access_secret_123';
const ADMIN_ACCESS_SECRET = process.env.ADMIN_ACCESS_SECRET || 'admin_access_secret_123';
const USER_REFRESH_SECRET = process.env.USER_REFRESH_SECRET || 'user_refresh_secret_123';
const ADMIN_REFRESH_SECRET = process.env.ADMIN_REFRESH_SECRET || 'admin_refresh_secret_123';
const generateAccessToken = (userId, role = 'user') => {
    const secret = (role === 'admin' || role === 'sub-admin') ? ADMIN_ACCESS_SECRET : USER_ACCESS_SECRET;
    return jsonwebtoken_1.default.sign({ user_id: userId, role }, secret, { expiresIn: '1d' }); // 1 day expiration
};
exports.generateAccessToken = generateAccessToken;
const generateRefreshToken = (userId, role = 'user') => {
    const secret = (role === 'admin' || role === 'sub-admin') ? ADMIN_REFRESH_SECRET : USER_REFRESH_SECRET;
    return jsonwebtoken_1.default.sign({ user_id: userId, role }, secret, { expiresIn: '7d' }); // 7 days expiration
};
exports.generateRefreshToken = generateRefreshToken;
