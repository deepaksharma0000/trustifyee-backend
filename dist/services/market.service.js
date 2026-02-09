"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLTP = void 0;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
/**
 * Abhi DB ya mock API se LTP
 * later AngelOne live feed laga sakte ho
 */
const getLTP = async (tradingsymbol) => {
    if (!config_1.config.appBaseUrl) {
        throw new Error("APP_BASE_URL is not set");
    }
    const res = await axios_1.default.get(`${config_1.config.appBaseUrl}/api/ltp/${tradingsymbol}`);
    return res.data.ltp;
};
exports.getLTP = getLTP;
