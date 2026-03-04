import { Response, NextFunction } from 'express';

export const checkPermission = (flag: string) => {
    return (req: any, res: Response, next: NextFunction) => {
        const user = req.user;
        if (!user) return res.status(401).json({ error: "Unauthorized", status: false });

        // Admin always has all permissions
        if (user.role === 'admin') return next();

        // Sub-Admin check
        if (user.role === 'sub-admin' || user.role === 'subadmin') {
            if (user.all_permission) return next();
            if (user[flag]) return next();
        }

        return res.status(403).json({
            error: `Access Denied: You do not have permission to perform this action (${flag})`,
            status: false
        });
    };
};
