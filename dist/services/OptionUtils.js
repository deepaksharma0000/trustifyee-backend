"use strict";
// src/services/OptionUtils.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.getATMStrike = getATMStrike;
/**
 * NIFTY / FINNIFTY ke liye ATM strike nikalta hai
 * Example:
 *  price = 25208 → 25200
 */
function getATMStrike(price, step = 50) {
    if (!price || price <= 0) {
        throw new Error("Invalid index price for ATM calculation");
    }
    return Math.round(price / step) * step;
}
