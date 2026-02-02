"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.placeOrderForClient = placeOrderForClient;
exports.getOrderStatusForClient = getOrderStatusForClient;
const AngelTokens_1 = __importDefault(require("../models/AngelTokens"));
const Instrument_1 = __importDefault(require("../models/Instrument"));
const AngelOneAdapter_1 = require("../adapters/AngelOneAdapter");
const logger_1 = require("../utils/logger");
const adapter = new AngelOneAdapter_1.AngelOneAdapter();
async function placeOrderForClient(clientcode, orderInput) {
    // STEP 0 - Client token
    const tokens = await AngelTokens_1.default.findOne({ clientcode });
    if (!tokens?.jwtToken) {
        throw new Error("No active session for clientcode");
    }
    // STEP 1 - BUY / SELL validate
    const txType = orderInput.side?.toUpperCase();
    if (txType !== "BUY" && txType !== "SELL") {
        throw new Error("Valid side (BUY/SELL) required");
    }
    // STEP 2 - Resolve option contract from DB
    const symbol = await Instrument_1.default.findOne({
        tradingsymbol: orderInput.tradingsymbol,
        exchange: "NFO"
    });
    if (!symbol) {
        throw new Error("Option contract not found in DB");
    }
    // new block 
    // let finalQuantity = orderInput.quantity;
    // // 🔥 NIFTY option trade → LOT based
    // if (
    //   symbol.instrumenttype === "OPTIDX" &&
    //   symbol.name === "NIFTY"
    // ) {
    //   const lotSize = symbol.lotSize || 65;
    //   const lots = Number(orderInput.quantity);
    //   if (!lots || lots <= 0) {
    //     throw new Error("Invalid lot count");
    //   }
    //   finalQuantity = lots * lotSize; // 🔥 MAGIC LINE
    // }
    // 🔥 LOT BASED QUANTITY FIX (NIFTY / BANKNIFTY)
    let finalQuantity = orderInput.quantity;
    if (symbol.instrumenttype === "OPTIDX" &&
        (symbol.name === "NIFTY" || symbol.name === "BANKNIFTY")) {
        if (!symbol.lotSize) {
            throw new Error("Lot size not found for index option");
        }
        finalQuantity = orderInput.quantity * symbol.lotSize;
    }
    // STEP 3 - Angel payload
    const payload = {
        variety: "NORMAL",
        tradingsymbol: symbol.tradingsymbol,
        symboltoken: symbol.symboltoken,
        transactiontype: txType,
        exchange: "NFO",
        ordertype: orderInput.ordertype || "MARKET",
        producttype: "INTRADAY",
        duration: "DAY",
        price: "0",
        // quantity: String(orderInput.quantity),
        // quantity: String(finalQuantity),
        quantity: String(finalQuantity),
        squareoff: "0",
        stoploss: "0"
    };
    logger_1.log.debug("Angel placeOrder payload:", payload);
    // STEP 4 - Place order
    return await adapter.authPost(tokens.jwtToken, "/rest/secure/angelbroking/order/v1/placeOrder", payload);
}
async function getOrderStatusForClient(clientcode, orderId) {
    const tokens = await AngelTokens_1.default.findOne({ clientcode });
    if (!tokens?.jwtToken) {
        throw new Error("No active session for clientcode");
    }
    return await adapter.getOrderStatus(tokens.jwtToken, orderId);
}
