import { Request, Response } from 'express';
import Ticket from '../models/Ticket';
import log from '../utils/logger';

export const getTicketsAdmin = async (req: Request, res: Response) => {
    try {
        const tickets = await Ticket.find().sort({ created_at: -1 });
        res.status(200).json({ data: tickets, status: true });
    } catch (error: any) {
        log.error("Get tickets error", error);
        res.status(500).json({ error: error.message, status: false });
    }
};

export const updateTicketStatus = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['Open', 'Closed', 'Pending'].includes(status)) {
            return res.status(400).json({ error: "Invalid status", status: false });
        }

        await Ticket.updateOne({ _id: id }, { status });
        const updated = await Ticket.findById(id);
        if (!updated) return res.status(404).json({ error: "Ticket not found", status: false });

        res.status(200).json({ message: "Ticket status updated!", data: updated, status: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message, status: false });
    }
};

export const deleteTicket = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const deleted = await Ticket.findByIdAndDelete(id);
        if (!deleted) return res.status(404).json({ error: "Ticket not found", status: false });
        res.status(200).json({ message: "Ticket deleted successfully!", status: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message, status: false });
    }
};
