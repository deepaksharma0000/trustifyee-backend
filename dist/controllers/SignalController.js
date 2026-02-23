"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getActiveSignals = exports.executeSignal = void 0;
const Signal_1 = require("../models/Signal");
const User_1 = __importDefault(require("../models/User"));
const Position_model_1 = require("../models/Position.model");
const OrderService_1 = require("../services/OrderService");
const logger_1 = require("../utils/logger");
const encryption_1 = require("../utils/encryption");
const executeSignal = async (req, res) => {
    try {
        const { signalId, lots } = req.body;
        const userId = req.id; // from auth middleware
        if (!signalId)
            return res.status(400).json({ error: "Signal ID is required", status: false });
        const signal = await Signal_1.Signal.findById(signalId);
        if (!signal || signal.status !== "ACTIVE") {
            return res.status(404).json({ error: "Signal not found or inactive", status: false });
        }
        const user = await User_1.default.findById(userId);
        if (!user || user.licence !== "Live") {
            return res.status(403).json({ error: "User not eligible for live execution", status: false });
        }
        if (!user.broker_verified) {
            return res.status(403).json({ error: "Broker not verified by admin", status: false });
        }
        const client_key = (0, encryption_1.decrypt)(user.client_key || "");
        if (!client_key)
            return res.status(400).json({ error: "Broker connection details missing", status: false });
        // Calculate quantity (assuming lot size = 1 if not provided, else multiply)
        // Note: Real lot size should come from contract, but here user specifies lots
        const quantity = (lots || 1) * signal.quantity;
        logger_1.log.info(`Executing signal ${signalId} for user ${user.user_name} with ${lots} lots`);
        try {
            const resp = await (0, OrderService_1.placeOrderForClient)(userId, client_key, {
                exchange: signal.exchange,
                tradingsymbol: signal.tradingsymbol,
                side: signal.side,
                transactiontype: signal.side,
                quantity: quantity,
                ordertype: "MARKET",
            });
            const orderid = resp?.data?.orderid || resp?.data?.data?.orderid || `SIG-${Date.now()}`;
            const position = await Position_model_1.Position.create({
                userId: userId,
                clientcode: client_key,
                orderid: orderid,
                tradingsymbol: signal.tradingsymbol,
                exchange: signal.exchange,
                side: signal.side,
                quantity: quantity,
                entryPrice: signal.price, // Or fetch live LTP
                status: "OPEN",
                strategy: signal.strategy,
                mode: "live",
                signalId: signal._id,
                signalType: signal.signalType
            });
            res.status(200).json({
                message: "Signal executed successfully!",
                status: true,
                data: position
            });
        }
        catch (orderErr) {
            logger_1.log.error(`Order failed for signal ${signalId}:`, orderErr);
            res.status(500).json({ error: orderErr.message || "Broker order failed", status: false });
        }
    }
    catch (err) {
        logger_1.log.error("Execution error:", err);
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.executeSignal = executeSignal;
const getActiveSignals = async (req, res) => {
    try {
        const signals = await Signal_1.Signal.find({ status: "ACTIVE" }).sort({ createdAt: -1 });
        res.status(200).json({ ok: true, data: signals });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
};
exports.getActiveSignals = getActiveSignals;
