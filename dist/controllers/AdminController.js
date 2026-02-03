"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateAdmin = exports.getAllAdmins = exports.getAdminById = void 0;
const Admin_1 = __importDefault(require("../models/Admin"));
const joi_1 = __importDefault(require("joi"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const updateAdminSchema = joi_1.default.object({
    full_name: joi_1.default.string().min(3).max(150).optional(),
    mobile: joi_1.default.string().pattern(/^[0-9]{10,15}$/).optional(),
    email: joi_1.default.string().email().optional(),
    password: joi_1.default.string().min(8).optional(),
    panel_client_key: joi_1.default.string().min(3).optional(),
    // Permissions
    all_permission: joi_1.default.boolean().optional(),
    add_client: joi_1.default.boolean().optional(),
    edit_client: joi_1.default.boolean().optional(),
    licence_permission: joi_1.default.boolean().optional(),
    go_to_dashboard: joi_1.default.boolean().optional(),
    trade_history: joi_1.default.boolean().optional(),
    full_info_view: joi_1.default.boolean().optional(),
    update_client_api_key: joi_1.default.boolean().optional(),
    strategy_permission: joi_1.default.boolean().optional(),
    group_service_permission: joi_1.default.boolean().optional(),
    role: joi_1.default.string().valid("admin", "sub-admin").optional(),
    status: joi_1.default.string().valid("active", "inactive").optional(),
});
const getAdminById = async (req, res) => {
    try {
        const { id } = req.params;
        const admin = await Admin_1.default.findById(id);
        if (!admin)
            return res.status(404).json({ message: "Admin not found", status: false });
        res.status(200).json({
            message: "Admin fetched successfully",
            status: true,
            result: admin
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.getAdminById = getAdminById;
const getAllAdmins = async (req, res) => {
    try {
        const admins = await Admin_1.default.find().select("full_name mobile email");
        if (!admins || admins.length === 0)
            return res.status(404).json({ message: "No admins found", status: false });
        res.status(200).json({
            message: "Admins fetched successfully",
            status: true,
            results: admins
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.getAllAdmins = getAllAdmins;
const updateAdmin = async (req, res) => {
    try {
        const { id } = req.params;
        const { error, value } = updateAdminSchema.validate(req.body);
        if (error)
            return res.status(400).json({ error: error.message, status: false });
        const updateData = { ...value };
        if (req.file) {
            updateData.profile_img = req.file.path;
        }
        if (updateData.password) {
            updateData.password = await bcryptjs_1.default.hash(updateData.password, 10);
        }
        const updatedAdmin = await Admin_1.default.findByIdAndUpdate(id, updateData, { new: true });
        if (!updatedAdmin)
            return res.status(404).json({ error: "Admin not found", status: false });
        res.status(200).json({
            message: "Admin updated successfully!",
            data: updatedAdmin,
            status: true
        });
    }
    catch (err) {
        // Handle unique constraint errors from Mongoose
        if (err.code === 11000) {
            return res.status(400).json({ error: "Duplicate key error (email, mobile, or key already exists)", status: false });
        }
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.updateAdmin = updateAdmin;
