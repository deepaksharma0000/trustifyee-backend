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
}

export const auth = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const access = req.header("x-access-token");

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
