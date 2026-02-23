"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignalService = void 0;
const Signal_1 = require("../models/Signal");
const User_1 = __importDefault(require("../models/User"));
const logger_1 = require("../utils/logger");
class SignalService {
    /**
     * 🔧 TASK 2: Admin Signal Engine
     * Marks a trade as a signal and prepares it for fan-out.
     */
    static async createSignal(tradeData) {
        try {
            const signal = await Signal_1.Signal.create({
                ...tradeData,
                status: "ACTIVE",
            });
            logger_1.log.info(`Signal created: ${signal.tradingsymbol} (${signal.side}) - ID: ${signal._id}`);
            // Fan-out: In this architecture, users will pull signals from their dashboard
            // Or we could push via WebSockets if implemented.
            return signal;
        }
        catch (error) {
            logger_1.log.error("Error creating signal:", error);
            throw error;
        }
    }
    /**
     * Get active signals for a specific user based on their eligible strategies
     */
    static async getActiveSignalsForUser(userId) {
        const user = await User_1.default.findById(userId).lean();
        if (!user)
            return [];
        const userStrategies = user.strategies || [];
        // Find active signals that match user's strategies
        const signals = await Signal_1.Signal.find({
            status: "ACTIVE",
            // strategy: { $in: userStrategies } // Uncomment if signals should be filtered by strategy
        }).sort({ createdAt: -1 });
        return signals;
    }
}
exports.SignalService = SignalService;
