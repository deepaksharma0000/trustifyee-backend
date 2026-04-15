import { Request, Response } from 'express';
import Message from '../models/Message';
import User from '../models/User';
import log from '../utils/logger';

export const createMessage = async (req: Request, res: Response) => {
    try {
        const { subject, message, target } = req.body;
        const adminId = (req as any).id; // from auth middleware

        if (!subject || !message) {
            return res.status(400).json({ error: "Subject and message are required", status: false });
        }

        const newMessage = new Message({
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
    } catch (error: any) {
        log.error("Create message error", error);
        res.status(500).json({ error: error.message, status: false });
    }
};

export const getMessagesAdmin = async (req: Request, res: Response) => {
    try {
        const messages = await Message.find().sort({ created_at: -1 });
        res.status(200).json({ data: messages, status: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message, status: false });
    }
};

export const deleteMessage = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const deleted = await Message.findByIdAndDelete(id);
        if (!deleted) return res.status(404).json({ error: "Message not found", status: false });
        res.status(200).json({ message: "Message deleted successfully!", status: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message, status: false });
    }
};

export const updateMessage = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { subject, message, target } = req.body;

        await Message.updateOne({ _id: id }, {
            subject,
            message,
            target
        });
        const updated = await Message.findById(id);

        if (!updated) return res.status(404).json({ error: "Message not found", status: false });

        res.status(200).json({ message: "Message updated successfully!", data: updated, status: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message, status: false });
    }
};

export const getMessagesUser = async (req: Request, res: Response) => {
    try {
        const userId = (req as any).id;
        const user = await User.findById(userId);

        if (!user) return res.status(404).json({ error: "User not found", status: false });

        // Logic for "today only":
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Fetch messages created today that target the user's category
        const query: any = {
            created_at: { $gte: today }
        };

        if (user.licence === 'Demo') {
            // Demo users get 'Demo' and 'All' messages
            query.target = { $in: ['All', 'Demo'] };
        } else {
            // Live users only get 'All' messages
            query.target = 'All';
        }

        const messages = await Message.find(query).sort({ created_at: -1 });

        res.status(200).json({ data: messages, status: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message, status: false });
    }
};
