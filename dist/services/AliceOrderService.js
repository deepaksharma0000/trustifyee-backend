"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.placeAliceOrderForClient = placeAliceOrderForClient;
exports.getAliceOrderStatusForClient = getAliceOrderStatusForClient;
// src/services/AliceOrderService.ts
const AliceTokens_1 = __importDefault(require("../models/AliceTokens"));
const AliceBlueAdapter_1 = require("../adapters/AliceBlueAdapter");
const AliceInstrument_1 = __importDefault(require("../models/AliceInstrument"));
const logger_1 = require("../utils/logger");
const adapter = new AliceBlueAdapter_1.AliceBlueAdapter();
async function findAliceSymbol(exchange, tradingSymbol) {
    const doc = await AliceInstrument_1.default.findOne({
        exchange: exchange.toUpperCase(),
        tradingSymbol: tradingSymbol
    }).lean(); // 🔹 yaha type fix
    if (!doc) {
        throw new Error(`Alice: Instrument not found in DB for ${exchange} ${tradingSymbol}`);
    }
    return {
        exchange: doc.exchange,
        tradingsymbol: doc.tradingSymbol,
        symboltoken: doc.token
    };
}
async function placeAliceOrderForClient(clientcode, orderInput) {
    const tokens = await AliceTokens_1.default.findOne({ clientcode });
    if (!tokens?.sessionId) {
        throw new Error("No active Alice session for clientcode");
    }
    // Agar client ne symboltoken directly nahi diya to DB se nikaalo
    let symbol;
    if (orderInput.symboltoken) {
        symbol = {
            exchange: orderInput.exchange.toUpperCase(),
            tradingsymbol: orderInput.tradingsymbol,
            symboltoken: orderInput.symboltoken
        };
    }
    else {
        symbol = await findAliceSymbol(orderInput.exchange, orderInput.tradingsymbol);
    }
    logger_1.log.debug("Alice Matched Symbol (Alice DB):", symbol);
    const rawTxType = orderInput.transactiontype || orderInput.side;
    const txType = rawTxType?.toString().toUpperCase();
    if (txType !== "BUY" && txType !== "SELL") {
        throw new Error(`Invalid Alice side/transactiontype: ${rawTxType}`);
    }
    const txTypeNarrow = txType;
    const payload = {
        exchange: symbol.exchange, // "NFO"
        tradingsymbol: symbol.tradingsymbol, // "ZYDUSLIFE24FEB26C1120"
        symboltoken: symbol.symboltoken, // "154929"
        transactiontype: txTypeNarrow,
        ordertype: orderInput.ordertype || "MARKET",
        producttype: orderInput.producttype || "INTRADAY",
        duration: orderInput.duration || "DAY",
        price: orderInput.price ?? 0,
        quantity: orderInput.quantity || 1,
        triggerPrice: orderInput.triggerPrice
    };
    logger_1.log.debug("Alice placeOrder payload:", payload);
    try {
        const resp = await adapter.placeOrder(tokens.sessionId, payload);
        return resp;
    }
    catch (err) {
        logger_1.log.error("placeAliceOrderForClient failed:", err.message || err);
        throw err;
    }
}
async function getAliceOrderStatusForClient(clientcode, orderId) {
    const tokens = await AliceTokens_1.default.findOne({ clientcode });
    if (!tokens?.sessionId) {
        throw new Error("No active Alice session for clientcode");
    }
    return await adapter.getOrderStatus(tokens.sessionId, orderId);
}
