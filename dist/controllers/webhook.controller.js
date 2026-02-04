"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleWebhookSignal = void 0;
const logger_1 = require("../utils/logger");
const MarketDataService_1 = require("../services/MarketDataService");
const NiftyOptionService_1 = require("../services/NiftyOptionService");
const User_1 = __importDefault(require("../models/User"));
const OrderService_1 = require("../services/OrderService");
const Position_model_1 = require("../models/Position.model");
const handleWebhookSignal = async (req, res) => {
    try {
        const { action, symbol, secret } = req.body;
        // 1. Basic Auth (Optional but recommended)
        // if (secret !== process.env.WEBHOOK_SECRET) {
        //   return res.status(401).json({ ok: false, message: "Unauthorized signal" });
        // }
        logger_1.log.info(`🚀 Webhook Received: ${action} for ${symbol}`);
        if (symbol !== "NIFTY") {
            return res.status(400).json({ ok: false, message: "Only NIFTY supported for now" });
        }
        // 2. Fetch Live LTP & ATM Strike
        const ltp = await (0, MarketDataService_1.getLiveNiftyLtp)();
        if (ltp <= 0)
            throw new Error("Could not fetch live LTP for webhook");
        const chain = await (0, NiftyOptionService_1.getNiftyOptionChain)(ltp);
        const atmStrike = chain.atmStrike;
        // 3. Decide CE or PE based on action
        // "BUY" signal from TradingView usually means bullish -> Buy CE
        // "SELL" signal from TradingView usually means bearish -> Buy PE
        const optionType = action.toUpperCase() === "BUY" ? "CE" : "PE";
        const targetOption = chain.options.find(o => o.strike === atmStrike && o.optiontype === optionType);
        if (!targetOption) {
            throw new Error(`Could not find ATM ${optionType} for strike ${atmStrike}`);
        }
        logger_1.log.info(`🎯 Target Instrument: ${targetOption.tradingsymbol}`);
        // 4. Find all Active Users
        const activeUsers = await User_1.default.find({ trading_status: "enabled", broker: "AngelOne" });
        if (activeUsers.length === 0) {
            logger_1.log.warn("No active users found for auto-trading");
            return res.json({ ok: true, message: "No active users" });
        }
        // 5. Fire Orders for all users
        const results = await Promise.all(activeUsers.map(async (user) => {
            try {
                const clientcode = user.client_key || user.panel_client_key;
                if (!clientcode)
                    return { user: user.user_name, status: "No client code" };
                const resp = await (0, OrderService_1.placeOrderForClient)(clientcode, {
                    exchange: "NFO",
                    tradingsymbol: targetOption.tradingsymbol,
                    side: "BUY",
                    quantity: 1, // You can make this dynamic based on user settings later
                    ordertype: "MARKET",
                    transactiontype: "BUY",
                    symboltoken: targetOption.symboltoken
                });
                if (resp && resp.status === true) {
                    // Save to Database
                    await Position_model_1.Position.create({
                        clientcode,
                        orderid: resp.data.orderid,
                        tradingsymbol: targetOption.tradingsymbol,
                        symboltoken: targetOption.symboltoken,
                        exchange: "NFO",
                        side: "BUY",
                        quantity: 1,
                        entryPrice: Number(resp.data.ltp) || 0,
                        status: "OPEN"
                    });
                    return { user: user.user_name, status: "Success", orderid: resp.data.orderid };
                }
                else {
                    return { user: user.user_name, status: "Failed", error: resp.message };
                }
            }
            catch (err) {
                return { user: user.user_name, status: "Error", error: err.message };
            }
        }));
        res.json({ ok: true, results });
    }
    catch (err) {
        logger_1.log.error("Webhook processing failed:", err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
};
exports.handleWebhookSignal = handleWebhookSignal;
