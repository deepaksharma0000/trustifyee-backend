"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.httpClient = void 0;
// src/utils/httpClient.ts
const axios_1 = __importDefault(require("axios"));
exports.httpClient = axios_1.default.create({
    timeout: 10000,
});
exports.httpClient.interceptors.response.use((res) => res, (err) => {
    // yahan central logging / error formatting kar sakte ho
    return Promise.reject(err);
});
