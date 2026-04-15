import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import dotenv from 'dotenv';
import User from '../models/User';
import Admin from '../models/Admin';

dotenv.config();

// Auto-reset login flags when a token is found to be expired
async function resetLoginState(type: 'admin' | 'user', token: string, secret: string, model: any): Promise<void> {
    try {
        // Decode without verification to get user_id from expired token
        const decoded = jwt.decode(token) as JwtPayload | null;
        if (decoded?.user_id) {
            if (type === 'user') {
                await model.updateOne({ _id: decoded.user_id }, { is_login: false, is_online: false });
            } else {
                await model.updateOne({ _id: decoded.user_id }, { is_login: false });
            }
        }
    } catch (_e) {
        // Silent — best effort only
    }
}

const USER_ACCESS_SECRET = process.env.USER_ACCESS_SECRET || 'user_access_secret_123';
const ADMIN_ACCESS_SECRET = process.env.ADMIN_ACCESS_SECRET || 'admin_access_secret_123';

interface AuthRequest extends Request {
    id?: string;
    user?: any;
    userType?: 'admin' | 'user';
}

const _commonAuth = async (req: AuthRequest, res: Response, next: NextFunction, secret: string, model: any, type: 'admin' | 'user') => {
    try {
        const authHeader = req.header("authorization");
        const bearerToken = authHeader?.startsWith("Bearer ")
            ? authHeader.slice(7).trim()
            : undefined;
        const access = bearerToken || req.header("x-access-token") || (req.query.token as string);

        if (!access) {
            return res.status(401).json({ error: "Access token is missing" });
        }

        const decoded = jwt.verify(access, secret) as JwtPayload;

        if (!decoded || !decoded.user_id) {
            return res.status(403).json({ error: "Invalid token payload" });
        }

        const user = await model.findById(decoded.user_id);

        if (!user) {
            return res.status(404).json({ error: `${type === 'admin' ? 'Admin' : 'User'} not found` });
        }

        if ((user as any).status === 'inactive') {
            return res.status(403).json({ error: "Account disabled. Please contact admin." });
        }

        if (type === 'user' && (user as any).licence === 'Demo' && (user as any).end_date) {
            const today = new Date();
            const expiryDate = new Date((user as any).end_date);
            const disableDate = new Date(expiryDate);
            disableDate.setDate(expiryDate.getDate() + 15);

            if (today > disableDate) {
                (user as any).status = 'inactive';
                await (user as any).save();
                return res.status(403).json({ error: "Demo grace period expired. Account disabled." });
            }
        }

        req.id = decoded.user_id;
        req.user = user;
        req.userType = type;

        next();

    } catch (error: any) {
        console.error(`${type.toUpperCase()} Auth Error:`, error);

        if (error.name === "TokenExpiredError") {
            // 🔥 Auto-reset login state in DB so Admin dashboard shows correct status
            const authHeader = req.header("authorization");
            const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
            const expiredToken = bearerToken || req.header("x-access-token") || (req.query.token as string);
            if (expiredToken) {
                await resetLoginState(type, expiredToken, secret, model);
            }
            return res.status(401).json({ error: "Access token has expired! Please login again.", code: "TOKEN_EXPIRED" });
        } else if (error.name === "JsonWebTokenError") {
            return res.status(403).json({ error: "Invalid access token" });
        } else {
            return res.status(500).json({ error: "Internal server error" });
        }
    }
};

export const userAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
    return _commonAuth(req, res, next, USER_ACCESS_SECRET, User, 'user');
};

export const adminAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
    return _commonAuth(req, res, next, ADMIN_ACCESS_SECRET, Admin, 'admin');
};

// Legacy support if needed, but should be avoided for strict isolation
export const auth = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const authHeader = req.header("authorization");
        const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
        const access = bearerToken || req.header("x-access-token") || (req.query.token as string);

        if (!access) return res.status(401).json({ error: "Access token is missing" });

        // Try Admin secret first
        try {
            const decoded = jwt.verify(access, ADMIN_ACCESS_SECRET) as JwtPayload;
            const admin = await Admin.findById(decoded.user_id);
            if (admin) {
                req.id = decoded.user_id;
                req.user = admin;
                req.userType = 'admin';
                return next();
            }
        } catch (e) { }

        // Then try User secret
        const decoded = jwt.verify(access, USER_ACCESS_SECRET) as JwtPayload;
        const user = await User.findById(decoded.user_id);
        if (user) {
            req.id = decoded.user_id;
            req.user = user;
            req.userType = 'user';
            return next();
        }

        return res.status(404).json({ error: "User or Admin not found" });
    } catch (error: any) {
        return res.status(403).json({ error: "Invalid or expired token" });
    }
};

export const adminOnly = (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.userType !== 'admin') {
        return res.status(403).json({ error: "Admin access required" });
    }
    return next();
};

export const commonAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const authHeader = req.header("authorization");
        const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
        let access = bearerToken || (req.header("x-access-token") as string) || (req.query.token as string);

        if (!access) return res.status(401).json({ error: "Access token is missing" });

        // TRY ADMIN
        try {
            const decoded = jwt.verify(access, ADMIN_ACCESS_SECRET) as JwtPayload;
            const admin = await Admin.findById(decoded.user_id);
            if (admin) {
                req.id = decoded.user_id;
                req.user = admin;
                req.userType = 'admin';
                return next();
            }
        } catch (e) {}

        // TRY USER
        const decoded = jwt.verify(access, USER_ACCESS_SECRET) as JwtPayload;
        const user = await User.findById(decoded.user_id);
        if (user) {
            req.id = decoded.user_id;
            req.user = user;
            req.userType = 'user';
            return next();
        }

        return res.status(403).json({ error: "Authorization failed" });
    } catch (e) {
        return res.status(403).json({ error: "Invalid or expired token" });
    }
};
