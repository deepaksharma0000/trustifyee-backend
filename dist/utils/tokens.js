"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateRefreshToken = exports.generateAccessToken = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const ACCESS_SECRET = process.env.accessSecret || 'access_secret_key_123';
const REFRESH_SECRET = process.env.refreshSecret || 'refresh_secret_key_123';
const generateAccessToken = (userId) => {
    return jsonwebtoken_1.default.sign({ user_id: userId }, ACCESS_SECRET, { expiresIn: '1d' }); // 1 day expiration
};
exports.generateAccessToken = generateAccessToken;
const generateRefreshToken = (userId) => {
    return jsonwebtoken_1.default.sign({ user_id: userId }, REFRESH_SECRET, { expiresIn: '7d' }); // 7 days expiration
};
exports.generateRefreshToken = generateRefreshToken;
