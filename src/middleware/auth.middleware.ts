import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import dotenv from 'dotenv';
import User from '../models/User';
import Admin from '../models/Admin';

dotenv.config();

const ACCESS_SECRET = process.env.accessSecret || 'access_secret_key_123';

interface AuthRequest extends Request {
    id?: string;
    user?: any;
    userType?: 'admin' | 'user';
}

export const auth = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const authHeader = req.header("authorization");
        const bearerToken = authHeader?.startsWith("Bearer ")
            ? authHeader.slice(7).trim()
            : undefined;
        const access = bearerToken || req.header("x-access-token");

        if (!access) {
            return res.status(401).json({ error: "Access token is missing" });
        }

        const decoded = jwt.verify(access, ACCESS_SECRET) as JwtPayload;

        if (!decoded || !decoded.user_id) {
            return res.status(403).json({ error: "Invalid token payload" });
        }

        // Check in User model first
        let user = await User.findById(decoded.user_id);
        if (!user) {
            // Check in Admin model
            user = await Admin.findById(decoded.user_id);
        }

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        req.id = decoded.user_id;
        req.user = user;
        req.userType = (user as any)?.role ? 'admin' : 'user';

        next();

    } catch (error: any) {
        console.error("Auth Error:", error);

        if (error.name === "TokenExpiredError") {
            return res.status(401).json({ error: "Access token has expired!" });
        } else if (error.name === "JsonWebTokenError") {
            return res.status(403).json({ error: "Invalid access token" });
        } else {
            return res.status(500).json({ error: "Internal server error" });
        }
    }
};

export const adminOnly = (req: AuthRequest, res: Response, next: NextFunction) => {
    const role = (req.user as any)?.role;
    if (role !== 'admin') {
        return res.status(403).json({ error: "Admin access required" });
    }
    return next();
};
