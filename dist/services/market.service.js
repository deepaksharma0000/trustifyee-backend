"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLTP = void 0;
const axios_1 = __importDefault(require("axios"));
/**
 * Abhi DB ya mock API se LTP
 * later AngelOne live feed laga sakte ho
 */
const getLTP = async (tradingsymbol) => {
    const res = await axios_1.default.get(`http://localhost:4000/api/ltp/${tradingsymbol}`);
    return res.data.ltp;
};
exports.getLTP = getLTP;
