"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aliceConfig = void 0;
const config_1 = require("./config");
exports.aliceConfig = {
    baseUrl: config_1.config.aliceBaseUrl,
    appCode: config_1.config.aliceAppCode,
    apiSecret: config_1.config.aliceApiSecret,
    redirectUrl: config_1.config.aliceRedirectUrl,
    getUserDetailsPath: config_1.config.aliceGetUserDetailsPath,
};
