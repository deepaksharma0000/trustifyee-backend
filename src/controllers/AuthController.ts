import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import Joi from 'joi';
import User, { IUser } from '../models/User';
import Admin, { IAdmin } from '../models/Admin';
import { generateAccessToken, generateRefreshToken } from '../utils/tokens';
import { validateEmail } from '../utils/functions';
import { v4 as uuidv4 } from 'uuid';
import { encrypt, maskKey } from '../utils/encryption';
import { sendWelcomeEmail } from '../utils/mail';

// Schemas
const adminRegisterSchema = Joi.object({
    full_name: Joi.string().min(3).max(150).required(),
    mobile: Joi.string().pattern(/^[0-9]{10,15}$/).required(),
    email: Joi.string().email().required(),
    password: Joi.string().min(6).optional(),
    panel_client_key: Joi.string().min(3).optional(),
    role: Joi.string().valid("admin", "sub-admin").default("sub-admin"),
    status: Joi.string().valid("active", "inactive").default("active"),
    // Permissions
    all_permission: Joi.boolean().default(false),
    add_client: Joi.boolean().default(false),
    edit_client: Joi.boolean().default(false),
    licence_permission: Joi.boolean().default(false),
    go_to_dashboard: Joi.boolean().default(false),
    trade_history: Joi.boolean().default(false),
    full_info_view: Joi.boolean().default(false),
    update_client_api_key: Joi.boolean().default(false),
    strategy_permission: Joi.boolean().default(false),
    group_service_permission: Joi.boolean().default(false),
});

const userRegisterSchema = Joi.object({
    user_name: Joi.string().required(),
    email: Joi.string().email().required(),
    full_name: Joi.string().required(),
    phone_number: Joi.string().required(),
    password: Joi.string().min(6).optional(),

    // Optional fields
    client_key: Joi.string().allow('', null).optional(),
    broker: Joi.string().allow('', null).optional(),
    status: Joi.string().valid('active', 'inactive').default('active'),
    trading_status: Joi.string().valid('enabled', 'disabled').default('enabled'),
    start_date: Joi.date().optional(),
    end_date: Joi.date().optional(),
    licence: Joi.string().valid('Live', 'Demo').default('Live'),
    to_month: Joi.string().allow('', null),
    sub_admin: Joi.string().allow('', null),
    service_to_month: Joi.string().allow('', null),
    group_service: Joi.string().allow('', null),
    strategies: Joi.array().items(Joi.string()).optional(),
    api_key: Joi.string().allow('', null).optional(),
    broker_verified: Joi.boolean().optional(),
    is_online: Joi.boolean().optional(),
    is_login: Joi.boolean().optional(),
}).unknown(true);

export const registerAdmin = async (req: Request, res: Response) => {
    try {
        const { error } = adminRegisterSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.message, status: false });

        const { email, mobile, panel_client_key, password } = req.body;

        const existingEmail = await Admin.findOne({ email });
        if (existingEmail) return res.status(400).json({ error: "Admin email already exists.", status: false });

        const existingMobile = await Admin.findOne({ mobile });
        if (existingMobile) return res.status(400).json({ error: "Mobile number already exists.", status: false });

        const existingKey = await Admin.findOne({ panel_client_key });
        if (existingKey) return res.status(400).json({ error: "Panel client key already exists.", status: false });

        const hashedPassword = await bcrypt.hash(password, 10);

        const newAdmin = new Admin({
            ...req.body,
            password: hashedPassword
        });

        await newAdmin.save();

        const accessToken = generateAccessToken(newAdmin._id);
        const refreshToken = generateRefreshToken(newAdmin._id);

        const adminObj = newAdmin.toObject() as any;
        delete adminObj.password;

        res.status(201).json({
            message: "Admin registration successful!",
            data: adminObj,
            status: true,
            access: { token: accessToken, issued_at: new Date() },
            refresh: { token: refreshToken, issued_at: new Date() },
        });

    } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: err.message, status: false });
    }
};

export const loginAdmin = async (req: Request, res: Response) => {
    try {
        const { email, password } = req.body;
        const loginIdentifier = email; // Frontend sends identifier as 'email'

        if (!loginIdentifier) return res.status(400).json({ error: "Email or Mobile Number is required", status: false });
        if (!password) return res.status(400).json({ error: "Password is required", status: false });

        // Search by email OR mobile
        const admin = await Admin.findOne({
            $or: [
                { email: loginIdentifier },
                { mobile: loginIdentifier }
            ]
        }).select('+password');

        if (!admin) return res.status(404).json({ error: "Admin/Sub-Admin account does not exist.", status: false });

        const isMatch = await bcrypt.compare(password, admin.password);
        if (!isMatch) return res.status(400).json({ error: "Invalid password", status: false });

        admin.is_login = true;
        await admin.save();

        const accessToken = generateAccessToken(admin._id, admin.role || 'admin');
        const refreshToken = generateRefreshToken(admin._id, admin.role || 'admin');

        const adminObj = admin.toObject() as any;
        delete adminObj.password;

        res.status(200).json({
            message: "Login successful!",
            data: adminObj,
            user: adminObj, // For frontend compatibility
            accessToken, // For frontend compatibility
            status: true,
            access: { token: accessToken, issued_at: new Date() },
            refresh: { token: refreshToken, issued_at: new Date() },
        });

    } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: err.message, status: false });
    }
}

export const registerUser = async (req: any, res: Response) => {
    try {
        const { error } = userRegisterSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.message, status: false });

        const actor = req.user; // Admin or Sub-Admin
        if (!actor) return res.status(401).json({ error: "Unauthorized: Actor not identified.", status: false });

        let { email, phone_number, user_name, licence, client_key, api_key, strategies, group_service } = req.body;

        // [PRODUCTION READY] Granular Permission Enforcement for Sub-Admins during Registration
        if (actor.role === 'sub-admin' || actor.role === 'subadmin') {
            if (!actor.all_permission) {
                if (!actor.add_client) {
                    return res.status(403).json({ error: "Access Denied: You do not have permission to Add New Clients", status: false });
                }
                if (licence && licence !== 'Demo' && !actor.licence_permission) {
                    return res.status(403).json({ error: "Access Denied: You do not have permission to assign 'Live' Licence", status: false });
                }
                if (strategies && strategies.length > 0 && !actor.strategy_permission) {
                    return res.status(403).json({ error: "Access Denied: You do not have permission to assign Strategies", status: false });
                }
                if (group_service && !actor.group_service_permission) {
                    return res.status(403).json({ error: "Access Denied: You do not have permission to assign Group Services", status: false });
                }
            }
        }

        const existingUser = await User.findOne({ $or: [{ email }, { phone_number }] });
        if (existingUser) return res.status(400).json({ error: "Email or phone exists.", status: false });

        const plainPassword = user_name.substring(0, 4).toLowerCase() + '@123';
        const hashedPassword = await bcrypt.hash(plainPassword, 10);

        // Encrypt sensitive fields
        if (client_key) client_key = encrypt(client_key);
        else client_key = uuidv4(); // Generate UUID if not provided

        if (api_key) api_key = encrypt(api_key);

        // Phase 1: Auto-schedule Demo for 2 days
        let start_date = req.body.start_date;
        let end_date = req.body.end_date;

        if (licence === 'Demo' && (!start_date || !end_date)) {
            const today = new Date();
            start_date = start_date || today;
            if (!end_date) {
                const twoDaysLater = new Date(today);
                twoDaysLater.setDate(today.getDate() + 2);
                twoDaysLater.setHours(15, 30, 0, 0);
                end_date = twoDaysLater;
            }
        }

        const newUser = new User({
            ...req.body,
            client_key,
            password: hashedPassword,
            start_date,
            end_date
        });

        await newUser.save();

        // Send Welcome Email [NEW]
        sendWelcomeEmail({
            email: newUser.email,
            full_name: newUser.full_name || newUser.user_name,
            user_name: newUser.user_name,
            password: plainPassword,
            licence: newUser.licence
        }).catch(err => console.error("Immediate Welcome Email Failed:", err));

        const maskedUser: any = {
            ...newUser.toObject(),
            client_key: maskKey(newUser.client_key || ""),
            api_key: maskKey(newUser.api_key || "")
        };
        delete maskedUser.password;

        res.status(201).json({
            message: "User registration successful!",
            data: maskedUser,
            status: true
        });

    } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: err.message, status: false });
    }
};

export const loginUser = async (req: Request, res: Response) => {
    try {
        const { user_name, password } = req.body;

        if (!user_name) return res.status(400).json({ error: "User name is required", status: false });
        if (!password) return res.status(400).json({ error: "Password is required", status: false });

        const user = await User.findOne({
            $or: [
                { user_name },
                { email: user_name }, // handle case where email was sent as user_name
                { email: req.body.email }
            ]
        }).select('+password');
        if (!user) return res.status(404).json({ error: "User does not exist.", status: false });

        // Phase 1: Check account status
        if (user.status === 'inactive') {
            return res.status(403).json({ error: "Your account is disabled. Please contact admin.", status: false });
        }

        // Phase 1: 15-day disabling logic for Demo users
        if (user.licence === 'Demo' && user.end_date) {
            const today = new Date();
            const expiryDate = new Date(user.end_date);
            const disableDate = new Date(expiryDate);
            disableDate.setDate(expiryDate.getDate() + 15);

            if (today > disableDate) {
                user.status = 'inactive';
                await user.save();
                return res.status(403).json({ error: "Your account have been disabled after 15 days of demo expiry. Please take a subscription.", status: false });
            }
        }

        const isMatch = await bcrypt.compare(password, user.password as string);
        if (!isMatch) return res.status(400).json({ error: "Invalid password", status: false });

        user.is_login = true;
        user.is_online = true;
        await user.save();

        const accessToken = generateAccessToken(user._id, 'user');
        const refreshToken = generateRefreshToken(user._id, 'user');

        const userObj = user.toObject() as any;
        delete userObj.password;

        const maskedUser = {
            ...userObj,
            client_key: maskKey(user.client_key || ""),
            api_key: maskKey(user.api_key || "")
        };

        res.status(200).json({
            message: "Login successful!",
            data: maskedUser,
            user: maskedUser, // For frontend compatibility
            accessToken, // For frontend compatibility
            status: true,
            access: { token: accessToken, issued_at: new Date() },
            refresh: { token: refreshToken, issued_at: new Date() },
        });

    } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: err.message, status: false });
    }
}

export const logoutAdmin = async (req: Request, res: Response) => {
    try {
        const adminId = (req as any).id;
        if (!adminId) return res.status(401).json({ error: "Unauthorized", status: false });

        await Admin.findByIdAndUpdate(adminId, { is_login: false });

        res.status(200).json({
            message: "Admin logged out successfully!",
            status: true
        });
    } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: err.message, status: false });
    }
}

export const logoutUser = async (req: Request, res: Response) => {
    try {
        const userId = (req as any).id;
        if (!userId) return res.status(401).json({ error: "Unauthorized", status: false });

        await User.findByIdAndUpdate(userId, { is_login: false, is_online: false });

        res.status(200).json({
            message: "User logged out successfully!",
            status: true
        });
    } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: err.message, status: false });
    }
}
