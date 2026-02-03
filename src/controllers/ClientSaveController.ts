import { Request, Response } from 'express';
import { ClientSave } from '../models/HelperModels';
import User from '../models/User';
import Joi from 'joi';

const clientSaveSchema = Joi.object({
    user_id: Joi.string().required(), // Using string for ObjectId
    user_name: Joi.string().min(3).max(100).required(),
    email: Joi.string().email().max(150).required(),
});

export const postClientSave = async (req: Request, res: Response) => {
    try {
        const { error } = clientSaveSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.message, status: false });

        const { user_id, user_name, email } = req.body;

        // Verify User Exists
        const userExists = await User.findById(user_id);
        if (!userExists) return res.status(404).json({ error: 'User ID not found in Users', status: false });

        const existing = await ClientSave.findOne({ email });
        if (existing) return res.status(400).json({ error: 'Email already exists.', status: false });

        const newClient = new ClientSave({ user_id, user_name, email });
        await newClient.save();

        res.status(201).json({
            message: 'Client saved successfully!',
            data: newClient,
            status: true
        });

    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const getClientByUserId = async (req: Request, res: Response) => {
    try {
        const { user_id } = req.params;
        const client = await ClientSave.findOne({ user_id });
        if (!client) return res.status(404).json({ error: "Client not found", status: false });

        res.status(200).json({ message: "Client found", data: client, status: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const getAllClients = async (req: Request, res: Response) => {
    try {
        const clients = await ClientSave.find();
        res.status(200).json({ message: "Clients retrieved", data: clients, status: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const deleteClient = async (req: Request, res: Response) => {
    try {
        const { user_id } = req.params;
        const deleted = await ClientSave.findOneAndDelete({ user_id });
        if (!deleted) return res.status(404).json({ error: "Client not found", status: false });

        res.status(200).json({ message: "Client deleted successfully", status: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}
