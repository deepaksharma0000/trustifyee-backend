"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTradeHistory = exports.closeOrder = exports.getActivePositions = exports.savePlacedOrder = exports.getOrderStatus = void 0;
const Position_model_1 = require("../models/Position.model");
const angel_service_1 = require("../services/angel.service");
const AngelOneAdapter_1 = require("../adapters/AngelOneAdapter");
const AngelTokens_1 = __importDefault(require("../models/AngelTokens"));
const Instrument_1 = __importDefault(require("../models/Instrument"));
const getOrderStatus = async (req, res) => {
    const { orderid, clientcode } = req.params;
    const user = req.user;
    const userType = req.userType;
    // Security check: If user, must match clientcode
    if (userType === 'user' && user.client_key !== clientcode) {
        return res.status(403).json({ ok: false, message: "Unauthorized access to these orders" });
    }
    const order = await Position_model_1.Position.findOne({ orderid });
    if (!order)
        return res.json({ ok: false });
    return res.json({
        ok: true,
        status: order.status, // PENDING | COMPLETE | REJECTED
    });
};
exports.getOrderStatus = getOrderStatus;
const savePlacedOrder = async (req, res) => {
    try {
        const { clientcode, orderid, tradingsymbol, exchange, side, quantity, price, symboltoken, autoSquareOffEnabled, // [NEW]
        autoSquareOffTime // [NEW]
         } = req.body;
        // [NEW] Check Market Status
        const MarketStatusService = require("../services/MarketStatusService").MarketStatusService;
        try {
            MarketStatusService.validateOrderRequest();
        }
        catch (err) {
            return res.status(400).json({ ok: false, message: err.message });
        }
        // Validate if Enabled
        let autoExitJobId = undefined;
        let autoExitStatus = "PENDING";
        if (autoSquareOffEnabled && autoSquareOffTime) {
            // Basic validation (optional)
            const exitDate = new Date(autoSquareOffTime);
            if (isNaN(exitDate.getTime())) {
                throw new Error("Invalid auto square-off time");
            }
        }
        const newPosition = await Position_model_1.Position.create({
            clientcode,
            orderid,
            tradingsymbol,
            exchange,
            side,
            quantity,
            entryPrice: price || 0,
            symboltoken,
            stopLossPrice: req.body.stopLossPrice,
            targetPrice: req.body.targetPrice,
            status: "OPEN",
            autoSquareOffEnabled: autoSquareOffEnabled || false,
            autoSquareOffTime: autoSquareOffTime ? new Date(autoSquareOffTime) : undefined,
            autoSquareOffStatus: autoSquareOffEnabled ? "PENDING" : undefined
        });
        // Schedule Job if enabled
        if (autoSquareOffEnabled && autoSquareOffTime) {
            const AutoExitService = require("../services/AutoExitService").AutoExitService; // Lazy load to avoid circular deps if any
            const jobId = await AutoExitService.scheduleExit(orderid, new Date(autoSquareOffTime));
            newPosition.autoSquareOffJobId = jobId;
            await newPosition.save();
        }
        res.json({ ok: true });
    }
    catch (err) {
        console.error("Save order error:", err);
        res.status(500).json({ ok: false, message: "Save order failed", error: err.message });
    }
};
exports.savePlacedOrder = savePlacedOrder;
const getActivePositions = async (req, res) => {
    try {
        const { clientcode } = req.params;
        const user = req.user;
        const userType = req.userType;
        // Security check: If user, must match clientcode
        if (userType === 'user' && user.client_key !== clientcode) {
            return res.status(403).json({ ok: false, message: "Unauthorized access to these positions" });
        }
        const positions = await Position_model_1.Position.find({ clientcode, status: "OPEN" }).sort({ createdAt: -1 }).lean();
        if (positions.length === 0) {
            return res.json({ ok: true, data: [] });
        }
        const tokens = await AngelTokens_1.default.findOne({ clientcode });
        if (!tokens?.jwtToken) {
            return res.status(401).json({ ok: false, message: "No active session for client" });
        }
        const adapter = new AngelOneAdapter_1.AngelOneAdapter();
        const positionsWithLtp = await Promise.all(positions.map(async (p) => {
            try {
                let currentSymbolToken = p.symboltoken;
                if (!currentSymbolToken) {
                    const inst = await Instrument_1.default.findOne({ tradingsymbol: p.tradingsymbol, exchange: p.exchange });
                    currentSymbolToken = inst?.symboltoken;
                }
                if (currentSymbolToken) {
                    const ltpResp = await adapter.getLtp(tokens.jwtToken, p.exchange, p.tradingsymbol, currentSymbolToken);
                    const ltp = ltpResp?.data?.ltp || 0;
                    const pnl = p.side === "BUY"
                        ? (ltp - p.entryPrice) * p.quantity
                        : (p.entryPrice - ltp) * p.quantity;
                    return { ...p, ltp, pnl };
                }
                return { ...p, ltp: 0, pnl: 0 };
            }
            catch (err) {
                return { ...p, ltp: 0, pnl: 0 };
            }
        }));
        res.json({ ok: true, data: positionsWithLtp });
    }
    catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
};
exports.getActivePositions = getActivePositions;
const closeOrder = async (req, res) => {
    try {
        const { clientcode, orderid } = req.body;
        // [NEW] Check Market Status (Allow force close if needed? Usually NO for live market)
        // admin might want to force close internally, but broker will reject anyway if market is closed.
        // Let's block it for consistency unless extended hours are supported.
        const MarketStatusService = require("../services/MarketStatusService").MarketStatusService;
        try {
            MarketStatusService.validateOrderRequest();
        }
        catch (err) {
            return res.status(400).json({ ok: false, message: err.message });
        }
        const position = await Position_model_1.Position.findOne({
            clientcode,
            orderid,
            status: "OPEN",
        });
        if (!position) {
            return res.status(404).json({
                ok: false,
                message: "Open position not found",
            });
        }
        const exitSide = position.side === "BUY" ? "SELL" : "BUY";
        // 🔥 EXIT = NEW ORDER PLACE
        const angelResp = await (0, angel_service_1.placeAngelOrder)({
            clientcode,
            tradingsymbol: position.tradingsymbol,
            exchange: position.exchange,
            side: exitSide,
            quantity: position.quantity,
            ordertype: "MARKET",
        });
        if (!angelResp?.ok) {
            // Check if it's already closed or failed
            return res.status(400).json({
                ok: false,
                message: angelResp?.error || "Angel exit order failed",
            });
        }
        // ✅ DB UPDATE
        position.status = "CLOSED";
        position.exitOrderId = angelResp.resp?.data?.orderid || "MANUAL";
        position.exitAt = new Date();
        await position.save();
        res.json({
            ok: true,
            message: "Position squared off successfully",
            orderid: position.exitOrderId
        });
        // [NEW] Cancel Auto Exit Job if exists
        if (position.autoSquareOffEnabled && position.autoSquareOffJobId) {
            const AutoExitService = require("../services/AutoExitService").AutoExitService;
            await AutoExitService.cancelExit(position.orderid);
            position.autoSquareOffStatus = "CANCELLED";
            await position.save();
        }
    }
    catch (err) {
        console.error("Close order error:", err);
        res.status(500).json({
            ok: false,
            message: "Failed to close position: " + err.message,
        });
    }
};
exports.closeOrder = closeOrder;
const getTradeHistory = async (req, res) => {
    try {
        const { clientcode } = req.params;
        const user = req.user;
        const userType = req.userType;
        // Security check: If user, must match clientcode
        if (userType === 'user' && user.client_key !== clientcode) {
            return res.status(403).json({ ok: false, message: "Unauthorized access to trade history" });
        }
        // Fetch closed positions, latest first
        const history = await Position_model_1.Position.find({ clientcode, status: "CLOSED" }).sort({ exitAt: -1 }).lean();
        // In a real scenario, you might also want to fetch exit LTP to show P&L 
        // but since they are closed, entryPrice and exitPrice (which we should store) are enough.
        // Note: Our model currently doesn't have 'exitPrice'. Let's assume we use entryPrice of the exit order or just the P&L at close.
        // For now, let's just return what we have.
        res.json({ ok: true, data: history });
    }
    catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
};
exports.getTradeHistory = getTradeHistory;
