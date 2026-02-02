"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getATMStrike = getATMStrike;
exports.getNearestExpiry = getNearestExpiry;
exports.getNearestStrike = getNearestStrike;
// src/utils/optionUtils.ts
function getATMStrike(niftyPrice) {
    return Math.round(niftyPrice / 50) * 50;
}
function getNearestExpiry(dates) {
    const now = new Date();
    return dates
        .filter(d => d > now)
        .sort((a, b) => a.getTime() - b.getTime())[0];
}
function getNearestStrike(availableStrikes, atm) {
    if (!availableStrikes.length)
        return atm;
    return availableStrikes.reduce((prev, curr) => Math.abs(curr - atm) < Math.abs(prev - atm) ? curr : prev);
}
