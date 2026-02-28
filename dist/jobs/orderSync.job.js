"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncPendingOrders = void 0;
const Position_model_1 = require("../models/Position.model");
const logger_1 = require("../utils/logger");
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
/**
 * Background job: Runs every 5 seconds
 * - Triggers Auto-Exit (Square Off) using the /close route
 */
const syncPendingOrders = async () => {
    try {
        const now = new Date();
        const openPositions = await Position_model_1.Position.find({
            status: "OPEN",
            autoSquareOffEnabled: true,
            autoSquareOffStatus: "PENDING",
            autoSquareOffTime: { $ne: null }
        });
        if (openPositions.length === 0)
            return;
        for (const pos of openPositions) {
            const exitTime = new Date(pos.autoSquareOffTime);
            if (now >= exitTime) {
                logger_1.log.info(`[Job:AutoExit] !!! TIME REACHED !!! Triggering square-off for ${pos.orderid} (${pos.tradingsymbol})`);
                try {
                    // Call the existing /close route with system bypass
                    const response = await axios_1.default.post(`${config_1.config.appBaseUrl}/api/orders/close`, {
                        clientcode: pos.clientcode,
                        orderid: pos.orderid
                    }, {
                        headers: {
                            'x-system-secret': 'INTERNAL_JOB_SECRET',
                            'Content-Type': 'application/json'
                        },
                        timeout: 10000
                    });
                    const result = response.data;
                    if (result?.ok) {
                        logger_1.log.info(`[Job:AutoExit] SUCCESS: Position ${pos.orderid} squared off via system job.`);
                        // Note: The /close route already updates the position in DB, 
                        // so we don't need to do it here.
                    }
                    else {
                        logger_1.log.error(`[Job:AutoExit] FAILED: Broker refused square-off for ${pos.orderid}:`, result?.message || result);
                        pos.autoSquareOffStatus = "FAILED";
                        await pos.save();
                    }
                }
                catch (err) {
                    logger_1.log.error(`[Job:AutoExit] EXCEPTION during square-off for ${pos.orderid}:`, err.message);
                    // 403 error would hit here if internal auth/adminOnly fails
                }
            }
        }
    }
    catch (err) {
        logger_1.log.error("[Job] syncPendingOrders failure:", err.message);
    }
};
exports.syncPendingOrders = syncPendingOrders;
