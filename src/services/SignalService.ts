import { Signal } from "../models/Signal";
import User from "../models/User";
import { log } from "../utils/logger";

export class SignalService {
    /**
     * 🔧 TASK 2: Admin Signal Engine
     * Marks a trade as a signal and prepares it for fan-out.
     */
    static async createSignal(tradeData: {
        symbol: string;
        exchange: string;
        side: "BUY" | "SELL";
        tradingsymbol: string;
        strike?: number;
        optiontype?: "CE" | "PE";
        expiry?: Date;
        price: number;
        quantity: number;
        strategy?: string;
        adminOrderId?: string;
        signalType: "ENTRY" | "EXIT";
    }) {
        try {
            const signal = await Signal.create({
                ...tradeData,
                status: "ACTIVE",
            });

            log.info(`Signal created: ${signal.tradingsymbol} (${signal.side}) - ID: ${signal._id}`);

            // Fan-out: In this architecture, users will pull signals from their dashboard
            // Or we could push via WebSockets if implemented.

            return signal;
        } catch (error) {
            log.error("Error creating signal:", error);
            throw error;
        }
    }

    /**
     * Get active signals for a specific user based on their eligible strategies
     */
    static async getActiveSignalsForUser(userId: string) {
        const user = await User.findById(userId).lean();
        if (!user) return [];

        const userStrategies = user.strategies || [];

        // Find active signals that match user's strategies
        const signals = await Signal.find({
            status: "ACTIVE",
            // strategy: { $in: userStrategies } // Uncomment if signals should be filtered by strategy
        }).sort({ createdAt: -1 });

        return signals;
    }
}
