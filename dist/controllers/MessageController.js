"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMessagesUser = exports.updateMessage = exports.deleteMessage = exports.getMessagesAdmin = exports.createMessage = void 0;
const Message_1 = __importDefault(require("../models/Message"));
const User_1 = __importDefault(require("../models/User"));
const logger_1 = require("../utils/logger");
const createMessage = async (req, res) => {
    try {
        const { subject, message, target } = req.body;
        const adminId = req.id; // from auth middleware
        if (!subject || !message) {
            return res.status(400).json({ error: "Subject and message are required", status: false });
        }
        const newMessage = new Message_1.default({
            subject,
            message,
            target: target || 'All',
            created_by: adminId
        });
        await newMessage.save();
        res.status(201).json({
            message: "Message dispatched successfully!",
            data: newMessage,
            status: true
        });
    }
    catch (error) {
        logger_1.log.error("Create message error", error);
        res.status(500).json({ error: error.message, status: false });
    }
};
exports.createMessage = createMessage;
const getMessagesAdmin = async (req, res) => {
    try {
        const messages = await Message_1.default.find().sort({ created_at: -1 });
        res.status(200).json({ data: messages, status: true });
    }
    catch (error) {
        res.status(500).json({ error: error.message, status: false });
    }
};
exports.getMessagesAdmin = getMessagesAdmin;
const deleteMessage = async (req, res) => {
    try {
        const { id } = req.params;
        const deleted = await Message_1.default.findByIdAndDelete(id);
        if (!deleted)
            return res.status(404).json({ error: "Message not found", status: false });
        res.status(200).json({ message: "Message deleted successfully!", status: true });
    }
    catch (error) {
        res.status(500).json({ error: error.message, status: false });
    }
};
exports.deleteMessage = deleteMessage;
const updateMessage = async (req, res) => {
    try {
        const { id } = req.params;
        const { subject, message, target } = req.body;
        const updated = await Message_1.default.findByIdAndUpdate(id, {
            subject,
            message,
            target
        }, { new: true });
        if (!updated)
            return res.status(404).json({ error: "Message not found", status: false });
        res.status(200).json({ message: "Message updated successfully!", data: updated, status: true });
    }
    catch (error) {
        res.status(500).json({ error: error.message, status: false });
    }
};
exports.updateMessage = updateMessage;
const getMessagesUser = async (req, res) => {
    try {
        const userId = req.id;
        const user = await User_1.default.findById(userId);
        if (!user)
            return res.status(404).json({ error: "User not found", status: false });
        // Logic for "today only":
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        // Fetch messages created today that target the user's category
        const query = {
            created_at: { $gte: today }
        };
        if (user.licence === 'Demo') {
            // Demo users get 'Demo' and 'All' messages
            query.target = { $in: ['All', 'Demo'] };
        }
        else {
            // Live users only get 'All' messages
            query.target = 'All';
        }
        const messages = await Message_1.default.find(query).sort({ created_at: -1 });
        res.status(200).json({ data: messages, status: true });
    }
    catch (error) {
        res.status(500).json({ error: error.message, status: false });
    }
};
exports.getMessagesUser = getMessagesUser;
