import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const USER_ACCESS_SECRET = process.env.USER_ACCESS_SECRET || 'user_access_secret_123';
const ADMIN_ACCESS_SECRET = process.env.ADMIN_ACCESS_SECRET || 'admin_access_secret_123';
const USER_REFRESH_SECRET = process.env.USER_REFRESH_SECRET || 'user_refresh_secret_123';
const ADMIN_REFRESH_SECRET = process.env.ADMIN_REFRESH_SECRET || 'admin_refresh_secret_123';

export const generateAccessToken = (userId: string | unknown, role: string = 'user') => {
    const secret = (role === 'admin' || role === 'sub-admin') ? ADMIN_ACCESS_SECRET : USER_ACCESS_SECRET;
    return jwt.sign({ user_id: userId, role }, secret, { expiresIn: '1d' }); // 1 day expiration
};

export const generateRefreshToken = (userId: string | unknown, role: string = 'user') => {
    const secret = (role === 'admin' || role === 'sub-admin') ? ADMIN_REFRESH_SECRET : USER_REFRESH_SECRET;
    return jwt.sign({ user_id: userId, role }, secret, { expiresIn: '7d' }); // 7 days expiration
};
