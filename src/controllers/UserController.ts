import { Request, Response } from 'express';
import User from '../models/User';
import Joi from 'joi';
import bcrypt from 'bcryptjs';

const updateUserSchema = Joi.object({
    user_name: Joi.string().optional(),
    email: Joi.string().email().optional(),
    full_name: Joi.string().optional(),
    phone_number: Joi.string().optional(),
    broker: Joi.string().allow('', null).optional(),
    status: Joi.string().valid('active', 'inactive').optional(),
    trading_status: Joi.string().valid('enabled', 'disabled').optional(),
    start_date: Joi.date().optional(),
    end_date: Joi.date().optional(),
    licence: Joi.string().valid('Live', 'Demo').optional(),
    to_month: Joi.string().allow('', null).optional(),
    sub_admin: Joi.string().allow('', null).optional(),
    service_to_month: Joi.string().allow('', null).optional(),
    group_service: Joi.string().allow('', null).optional(),
    password: Joi.string().min(6).optional(),
    strategies: Joi.array().items(Joi.string()).optional(),
    api_key: Joi.string().allow('', null).optional(),
    client_key: Joi.string().allow('', null).optional(),
});

export const updateUser = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { error, value } = updateUserSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.message, status: false });

        const updateData = { ...value };

        if (updateData.client_key === "") {
            delete updateData.client_key;
        }
        if (updateData.api_key === "") {
            delete updateData.api_key;
        }

        if (updateData.password) {
            updateData.password = await bcrypt.hash(updateData.password, 10);
        }

        const updatedUser = await User.findByIdAndUpdate(id, updateData, { new: true });
        if (!updatedUser) return res.status(404).json({ error: "User not found", status: false });

        res.status(200).json({
            message: "User updated successfully!",
            data: updatedUser,
            status: true
        });

    } catch (err: any) {
        if (err.code === 11000) {
            return res.status(400).json({ error: "Duplicate error", status: false });
        }
        res.status(500).json({ error: err.message, status: false });
    }
};

export const deleteUser = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const deleted = await User.findByIdAndDelete(id);
        if (!deleted) return res.status(404).json({ message: "User not found", status: false });

        res.status(200).json({ message: "User deleted successfully!", status: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const getLoggedInUsers = async (req: Request, res: Response) => {
    try {
        const users = await User.find({ is_login: true });
        res.status(200).json({
            message: "Logged-in users fetched successfully!",
            count: users.length,
            data: users,
            status: true
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const getUserTotalCount = async (req: Request, res: Response) => {
    try {
        const count = await User.countDocuments();
        res.status(200).json({ total_users: count, status: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const getUsersByEndDate = async (req: Request, res: Response) => {
    try {
        const { filter, date } = req.query;
        let query: any = {};
        const today = new Date();

        if (filter === "expired") {
            query.end_date = { $lt: today };
        } else if (filter === "active") {
            query.end_date = { $gte: today };
        } else if (filter === "custom" && date) {
            query.end_date = { $lte: new Date(date as string) };
        }

        const users = await User.find(query);
        res.status(200).json({
            message: "Users fetched successfully!",
            count: users.length,
            data: users,
            status: true
        });

    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const getUserSearch = async (req: Request, res: Response) => {
    try {
        const { name, user_name, full_name, phone_number, mobile_number } = req.query;

        const nameTerm = (user_name || full_name || name || "").toString().trim();
        const phoneTerm = (phone_number || mobile_number || "").toString().trim();

        let query: any = {};

        if (nameTerm) {
            query.$or = [
                { user_name: { $regex: nameTerm, $options: 'i' } },
                { full_name: { $regex: nameTerm, $options: 'i' } }
            ];
        }

        if (phoneTerm) {
            query.phone_number = { $regex: phoneTerm, $options: 'i' };
        }

        const users = await User.find(query);
        res.status(200).json({
            users,
            total_users: users.length,
            status: true
        });

    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}
