import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import dotenv from 'dotenv';
import User from '../models/User';
import Admin from '../models/Admin';

dotenv.config();

async function resetLoginState(type: 'admin' | 'user', token: string, secret: string, model: any): Promise<void> {
    try {
        const decoded = jwt.decode(token) as JwtPayload | null;
        if (decoded?.user_id) {
            await model.updateOne({ _id: decoded.user_id }, { is_login: false });
        }
    } catch (_e) {
        // best effort only
    }
}

const USER_ACCESS_SECRET = process.env.USER_ACCESS_SECRET || 'user_access_secret_123';
const ADMIN_ACCESS_SECRET = process.env.ADMIN_ACCESS_SECRET || 'admin_access_secret_123';

interface AuthRequest extends Request {
    id?: string;
    user?: any;
    userType?: 'admin' | 'user';
}

function extractTokenCandidates(req: Request): string[] {
    const authHeader = String(req.header('authorization') || '').trim();
    const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : '';
    const rawAuthorizationToken = bearerToken ? '' : authHeader;
    const xAccessToken = String(req.header('x-access-token') || '').trim();
    const queryToken = String((req.query.token as string) || '').trim();

    const candidates = [bearerToken, rawAuthorizationToken, xAccessToken, queryToken].filter(Boolean);
    return Array.from(new Set(candidates));
}

const _commonAuth = async (
    req: AuthRequest,
    res: Response,
    next: NextFunction,
    secret: string,
    model: any,
    type: 'admin' | 'user'
) => {
    try {
        const candidates = extractTokenCandidates(req);

        if (!candidates.length) {
            return res.status(401).json({ error: 'Access token is missing' });
        }

        let lastError: any = null;

        for (const access of candidates) {
            try {
                const decoded = jwt.verify(access, secret) as JwtPayload;

                if (!decoded || !decoded.user_id) {
                    lastError = new Error('INVALID_TOKEN_PAYLOAD');
                    continue;
                }

                const user = await model.findById(decoded.user_id);

                if (!user) {
                    lastError = new Error('AUTH_SUBJECT_NOT_FOUND');
                    continue;
                }

                if ((user as any).status === 'inactive') {
                    return res.status(403).json({ error: 'Account disabled. Please contact admin.' });
                }

                if (type === 'user' && (user as any).licence === 'Demo' && (user as any).end_date) {
                    const today = new Date();
                    const expiryDate = new Date((user as any).end_date);
                    const disableDate = new Date(expiryDate);
                    disableDate.setDate(expiryDate.getDate() + 15);

                    if (today > disableDate) {
                        (user as any).status = 'inactive';
                        await (user as any).save();
                        return res.status(403).json({ error: 'Demo grace period expired. Account disabled.' });
                    }
                }

                req.id = decoded.user_id;
                req.user = user;
                req.userType = type;

                return next();
            } catch (error: any) {
                lastError = error;
            }
        }

        if (lastError?.message === 'AUTH_SUBJECT_NOT_FOUND') {
            return res.status(404).json({ error: `${type === 'admin' ? 'Admin' : 'User'} not found` });
        }
        if (lastError?.message === 'INVALID_TOKEN_PAYLOAD') {
            return res.status(403).json({ error: 'Invalid token payload' });
        }

        throw lastError || new Error('AUTH_FAILED');
    } catch (error: any) {
        console.error(`${type.toUpperCase()} Auth Error:`, error);

        if (error.name === 'TokenExpiredError') {
            const expiredToken = extractTokenCandidates(req)[0];
            if (expiredToken) {
                await resetLoginState(type, expiredToken, secret, model);
            }
            return res.status(401).json({ error: 'Access token has expired! Please login again.', code: 'TOKEN_EXPIRED' });
        }
        if (error.name === 'JsonWebTokenError') {
            return res.status(403).json({ error: 'Invalid access token' });
        }

        return res.status(500).json({ error: 'Internal server error' });
    }
};

export const userAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
    return _commonAuth(req, res, next, USER_ACCESS_SECRET, User, 'user');
};

export const adminAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
    return _commonAuth(req, res, next, ADMIN_ACCESS_SECRET, Admin, 'admin');
};

export const auth = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const candidates = extractTokenCandidates(req);
        if (!candidates.length) return res.status(401).json({ error: 'Access token is missing' });

        for (const access of candidates) {
            try {
                const adminDecoded = jwt.verify(access, ADMIN_ACCESS_SECRET) as JwtPayload;
                const admin = await Admin.findById(adminDecoded.user_id);
                if (admin) {
                    req.id = adminDecoded.user_id;
                    req.user = admin;
                    req.userType = 'admin';
                    return next();
                }
            } catch {
                // try user token path
            }

            try {
                const userDecoded = jwt.verify(access, USER_ACCESS_SECRET) as JwtPayload;
                const user = await User.findById(userDecoded.user_id);
                if (user) {
                    req.id = userDecoded.user_id;
                    req.user = user;
                    req.userType = 'user';
                    return next();
                }
            } catch {
                // continue next candidate
            }
        }

        return res.status(403).json({ error: 'Invalid or expired token' });
    } catch {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }
};

export const adminOnly = (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.userType !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    return next();
};

export const commonAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const candidates = extractTokenCandidates(req);
        if (!candidates.length) return res.status(401).json({ error: 'Access token is missing' });

        for (const access of candidates) {
            try {
                const adminDecoded = jwt.verify(access, ADMIN_ACCESS_SECRET) as JwtPayload;
                const admin = await Admin.findById(adminDecoded.user_id);
                if (admin) {
                    req.id = adminDecoded.user_id;
                    req.user = admin;
                    req.userType = 'admin';
                    return next();
                }
            } catch {
                // try user
            }

            try {
                const userDecoded = jwt.verify(access, USER_ACCESS_SECRET) as JwtPayload;
                const user = await User.findById(userDecoded.user_id);
                if (user) {
                    req.id = userDecoded.user_id;
                    req.user = user;
                    req.userType = 'user';
                    return next();
                }
            } catch {
                // continue
            }
        }

        return res.status(403).json({ error: 'Authorization failed' });
    } catch {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }
};
