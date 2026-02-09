"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkAngelOrderStatus = exports.placeAngelOrder = void 0;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const placeAngelOrder = async (payload) => {
    if (!config_1.config.appBaseUrl) {
        throw new Error("APP_BASE_URL is not set");
    }
    const res = await axios_1.default.post(`${config_1.config.appBaseUrl}/api/orders/place`, payload);
    return res.data; // { ok, resp }
};
exports.placeAngelOrder = placeAngelOrder;
// ✅ ye function alag hi rahega
const checkAngelOrderStatus = async (clientcode, orderid) => {
    if (!config_1.config.appBaseUrl) {
        throw new Error("APP_BASE_URL is not set");
    }
    const res = await axios_1.default.get(`${config_1.config.appBaseUrl}/api/orders/status/${clientcode}/${orderid}`);
    return res.data === true;
};
exports.checkAngelOrderStatus = checkAngelOrderStatus;
