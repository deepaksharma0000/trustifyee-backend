import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const ACCESS_SECRET = process.env.accessSecret || 'access_secret_key_123';
const REFRESH_SECRET = process.env.refreshSecret || 'refresh_secret_key_123';

export const generateAccessToken = (userId: string | unknown) => {
    return jwt.sign({ user_id: userId }, ACCESS_SECRET, { expiresIn: '1d' }); // 1 day expiration
};

export const generateRefreshToken = (userId: string | unknown) => {
    return jwt.sign({ user_id: userId }, REFRESH_SECRET, { expiresIn: '7d' }); // 7 days expiration
};
