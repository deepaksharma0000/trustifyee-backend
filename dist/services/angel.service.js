"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkAngelOrderStatus = exports.placeAngelOrder = void 0;
const axios_1 = __importDefault(require("axios"));
const placeAngelOrder = async (payload) => {
    const res = await axios_1.default.post("http://localhost:4000/api/orders/place", payload);
    return res.data; // { ok, resp }
};
exports.placeAngelOrder = placeAngelOrder;
// ✅ ye function alag hi rahega
const checkAngelOrderStatus = async (clientcode, orderid) => {
    const res = await axios_1.default.get(`http://localhost:4000/api/orders/status/${clientcode}/${orderid}`);
    return res.data === true;
};
exports.checkAngelOrderStatus = checkAngelOrderStatus;
