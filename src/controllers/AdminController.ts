import { Request, Response } from 'express';
import Admin from '../models/Admin';
import Joi from 'joi';
import bcrypt from 'bcryptjs';

const updateAdminSchema = Joi.object({
    full_name: Joi.string().min(3).max(150).optional(),
    mobile: Joi.string().pattern(/^[0-9]{10,15}$/).optional(),
    email: Joi.string().email().optional(),
    password: Joi.string().min(8).optional(),
    panel_client_key: Joi.string().min(3).optional(),
    // Permissions
    all_permission: Joi.boolean().optional(),
    add_client: Joi.boolean().optional(),
    edit_client: Joi.boolean().optional(),
    licence_permission: Joi.boolean().optional(),
    go_to_dashboard: Joi.boolean().optional(),
    trade_history: Joi.boolean().optional(),
    full_info_view: Joi.boolean().optional(),
    update_client_api_key: Joi.boolean().optional(),
    strategy_permission: Joi.boolean().optional(),
    group_service_permission: Joi.boolean().optional(),
    role: Joi.string().valid("admin", "sub-admin").optional(),
    status: Joi.string().valid("active", "inactive").optional(),
});

export const getAdminById = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const admin = await Admin.findById(id);

        if (!admin) return res.status(404).json({ message: "Admin not found", status: false });

        res.status(200).json({
            message: "Admin fetched successfully",
            status: true,
            result: admin
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const getAllAdmins = async (req: Request, res: Response) => {
    try {
        const admins = await Admin.find().select("full_name mobile email");
        if (!admins || admins.length === 0) return res.status(404).json({ message: "No admins found", status: false });

        res.status(200).json({
            message: "Admins fetched successfully",
            status: true,
            results: admins
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const updateAdmin = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { error, value } = updateAdminSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.message, status: false });

        const updateData: any = { ...value };

        if (req.file) {
            updateData.profile_img = req.file.path;
        }

        if (updateData.password) {
            updateData.password = await bcrypt.hash(updateData.password, 10);
        }

        const updatedAdmin = await Admin.findByIdAndUpdate(id, updateData, { new: true });

        if (!updatedAdmin) return res.status(404).json({ error: "Admin not found", status: false });

        res.status(200).json({
            message: "Admin updated successfully!",
            data: updatedAdmin,
            status: true
        });

    } catch (err: any) {
        // Handle unique constraint errors from Mongoose
        if (err.code === 11000) {
            return res.status(400).json({ error: "Duplicate key error (email, mobile, or key already exists)", status: false });
        }
        res.status(500).json({ error: err.message, status: false });
    }
}
