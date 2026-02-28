"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.placeOrderForClient = placeOrderForClient;
exports.getOrderStatusForClient = getOrderStatusForClient;
const AngelTokens_1 = __importDefault(require("../models/AngelTokens"));
const UpstoxTokens_1 = __importDefault(require("../models/UpstoxTokens"));
const Instrument_1 = __importDefault(require("../models/Instrument"));
const UpstoxInstrument_1 = __importDefault(require("../models/UpstoxInstrument"));
const AngelOneAdapter_1 = require("../adapters/AngelOneAdapter");
const UpstoxAdapter_1 = require("../adapters/UpstoxAdapter");
const logger_1 = require("../utils/logger");
const adapter = new AngelOneAdapter_1.AngelOneAdapter();
const upstoxAdapter = new UpstoxAdapter_1.UpstoxAdapter();
async function placeOrderForClient(userId, clientcode, orderInput) {
    // 1. Check AngelOne tokens
    const angelTokens = await AngelTokens_1.default.findOne({ userId, clientcode }).lean();
    // 2. Check Upstox tokens if Angel fails or if clientcode looks like Upstox
    const upstoxTokens = !angelTokens?.jwtToken ? await UpstoxTokens_1.default.findOne({ userId }).lean() : null;
    if (!angelTokens?.jwtToken && !upstoxTokens?.accessToken) {
        throw new Error("No active broker session found for this user (Angel or Upstox)");
    }
    const txType = orderInput.side?.toUpperCase();
    if (txType !== "BUY" && txType !== "SELL") {
        throw new Error("Valid side (BUY/SELL) required");
    }
    // Case A: AngelOne
    if (angelTokens?.jwtToken) {
        const symbol = await Instrument_1.default.findOne({
            tradingsymbol: orderInput.tradingsymbol,
            exchange: "NFO"
        });
        if (!symbol) {
            throw new Error("Option contract not found in DB (Angel)");
        }
        let finalQuantity = orderInput.quantity;
        if (symbol.instrumenttype === "OPTIDX" &&
            (symbol.name === "NIFTY" || symbol.name === "BANKNIFTY" || symbol.name === "FINNIFTY")) {
            if (!symbol.lotSize)
                throw new Error("Lot size not found for index option");
            finalQuantity = orderInput.quantity * symbol.lotSize;
        }
        const payload = {
            variety: "NORMAL",
            tradingsymbol: symbol.tradingsymbol,
            symboltoken: symbol.symboltoken,
            transactiontype: txType,
            exchange: "NFO",
            ordertype: orderInput.ordertype || "MARKET",
            producttype: "INTRADAY",
            duration: "DAY",
            price: orderInput.ordertype === "LIMIT" ? String(orderInput.price || 0) : "0",
            quantity: String(finalQuantity),
            squareoff: "0",
            stoploss: "0"
        };
        logger_1.log.debug("Angel placeOrder payload:", payload);
        return await adapter.authPost(angelTokens.jwtToken, "/rest/secure/angelbroking/order/v1/placeOrder", payload);
    }
    // Case B: Upstox
    if (upstoxTokens?.accessToken) {
        const symbol = await UpstoxInstrument_1.default.findOne({
            tradingsymbol: orderInput.tradingsymbol
        });
        if (!symbol) {
            throw new Error("Option contract not found in DB (Upstox)");
        }
        let finalQuantity = orderInput.quantity;
        if (symbol.lot_size) {
            finalQuantity = orderInput.quantity * symbol.lot_size;
        }
        const payload = {
            instrument_token: symbol.instrument_key,
            quantity: finalQuantity,
            order_type: orderInput.ordertype || "MARKET",
            transaction_type: txType,
            product: "I", // Intraday
            validity: "DAY",
            price: orderInput.ordertype === "LIMIT" ? (orderInput.price || 0) : 0,
            trigger_price: 0,
            disclosed_quantity: 0,
            is_amo: false,
            remark: "signal-order"
        };
        logger_1.log.debug("Upstox placeOrder payload:", payload);
        const resp = await upstoxAdapter.placeOrder(upstoxTokens.accessToken, payload);
        return { status: true, data: resp.data }; // Match AngelOne response structure loosely
    }
    throw new Error("Execution failed: No valid broker flow matched");
}
async function getOrderStatusForClient(userId, clientcode, orderId) {
    const angelTokens = await AngelTokens_1.default.findOne({ userId, clientcode }).lean();
    if (angelTokens?.jwtToken) {
        const orderBookResp = await adapter.getOrderBook(angelTokens.jwtToken);
        if (orderBookResp && orderBookResp.status && Array.isArray(orderBookResp.data)) {
            const order = orderBookResp.data.find((o) => o.orderid === orderId);
            if (order)
                return { status: true, data: order };
        }
        return await adapter.getOrderStatus(angelTokens.jwtToken, orderId);
    }
    const upstoxTokens = await UpstoxTokens_1.default.findOne({ userId }).lean();
    if (upstoxTokens?.accessToken) {
        // Upstox order status usually via order history or specific ID
        // Simplification for now
        return { status: true, data: { status: "unknown", message: "Upstox status check pending" } };
    }
    throw new Error("No active session for this user");
}
