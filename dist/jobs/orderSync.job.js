"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncPendingOrders = void 0;
const Position_model_1 = require("../models/Position.model");
const angel_service_1 = require("../services/angel.service");
/**
 * Background job:
 * - OPEN orders ko AngelOne se check karta hai
 * - fill hone par CLOSED mark karta hai
 */
const syncPendingOrders = async () => {
    try {
        // 🔥 Sirf OPEN positions check karo
        const openOrders = await Position_model_1.Position.find({
            status: "OPEN",
        });
        for (const order of openOrders) {
            // AngelOne se sirf TRUE / FALSE milta hai
            const isFilled = await (0, angel_service_1.checkAngelOrderStatus)(order.clientcode, order.orderid);
            // Agar order fill ho gaya
            if (isFilled) {
                order.status = "CLOSED";
                await order.save();
            }
        }
    }
    catch (err) {
        console.error("Order sync failed:", err);
    }
};
exports.syncPendingOrders = syncPendingOrders;
