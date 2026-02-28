"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteTicket = exports.updateTicketStatus = exports.getTicketsAdmin = void 0;
const Ticket_1 = __importDefault(require("../models/Ticket"));
const logger_1 = require("../utils/logger");
const getTicketsAdmin = async (req, res) => {
    try {
        const tickets = await Ticket_1.default.find().sort({ created_at: -1 });
        res.status(200).json({ data: tickets, status: true });
    }
    catch (error) {
        logger_1.log.error("Get tickets error", error);
        res.status(500).json({ error: error.message, status: false });
    }
};
exports.getTicketsAdmin = getTicketsAdmin;
const updateTicketStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        if (!['Open', 'Closed', 'Pending'].includes(status)) {
            return res.status(400).json({ error: "Invalid status", status: false });
        }
        const updated = await Ticket_1.default.findByIdAndUpdate(id, { status }, { new: true });
        if (!updated)
            return res.status(404).json({ error: "Ticket not found", status: false });
        res.status(200).json({ message: "Ticket status updated!", data: updated, status: true });
    }
    catch (error) {
        res.status(500).json({ error: error.message, status: false });
    }
};
exports.updateTicketStatus = updateTicketStatus;
const deleteTicket = async (req, res) => {
    try {
        const { id } = req.params;
        const deleted = await Ticket_1.default.findByIdAndDelete(id);
        if (!deleted)
            return res.status(404).json({ error: "Ticket not found", status: false });
        res.status(200).json({ message: "Ticket deleted successfully!", status: true });
    }
    catch (error) {
        res.status(500).json({ error: error.message, status: false });
    }
};
exports.deleteTicket = deleteTicket;
