"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteClient = exports.getAllClients = exports.getClientByUserId = exports.postClientSave = void 0;
const HelperModels_1 = require("../models/HelperModels");
const User_1 = __importDefault(require("../models/User"));
const joi_1 = __importDefault(require("joi"));
const clientSaveSchema = joi_1.default.object({
    user_id: joi_1.default.string().required(), // Using string for ObjectId
    user_name: joi_1.default.string().min(3).max(100).required(),
    email: joi_1.default.string().email().max(150).required(),
});
const postClientSave = async (req, res) => {
    try {
        const { error } = clientSaveSchema.validate(req.body);
        if (error)
            return res.status(400).json({ error: error.message, status: false });
        const { user_id, user_name, email } = req.body;
        // Verify User Exists
        const userExists = await User_1.default.findById(user_id);
        if (!userExists)
            return res.status(404).json({ error: 'User ID not found in Users', status: false });
        const existing = await HelperModels_1.ClientSave.findOne({ email });
        if (existing)
            return res.status(400).json({ error: 'Email already exists.', status: false });
        const newClient = new HelperModels_1.ClientSave({ user_id, user_name, email });
        await newClient.save();
        res.status(201).json({
            message: 'Client saved successfully!',
            data: newClient,
            status: true
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.postClientSave = postClientSave;
const getClientByUserId = async (req, res) => {
    try {
        const { user_id } = req.params;
        const client = await HelperModels_1.ClientSave.findOne({ user_id });
        if (!client)
            return res.status(404).json({ error: "Client not found", status: false });
        res.status(200).json({ message: "Client found", data: client, status: true });
    }
    catch (err) {
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.getClientByUserId = getClientByUserId;
const getAllClients = async (req, res) => {
    try {
        const clients = await HelperModels_1.ClientSave.find();
        res.status(200).json({ message: "Clients retrieved", data: clients, status: true });
    }
    catch (err) {
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.getAllClients = getAllClients;
const deleteClient = async (req, res) => {
    try {
        const { user_id } = req.params;
        const deleted = await HelperModels_1.ClientSave.findOneAndDelete({ user_id });
        if (!deleted)
            return res.status(404).json({ error: "Client not found", status: false });
        res.status(200).json({ message: "Client deleted successfully", status: true });
    }
    catch (err) {
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.deleteClient = deleteClient;
