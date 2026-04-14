import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import AngelTokensModel from "../models/AngelTokens";
import { config } from "../config";
import { log } from "../utils/logger";
import { decrypt, ensureEncrypted } from "../utils/encryption";
import User from "../models/User";
import Admin from "../models/Admin";

export interface MarginInfo {
    availablecash: number;
    collateral: number;
    utilisedspan: number;
    totalusablemargin: number;
}

export class RiskManagementService {
    // Removed static adapter to enforce per-user keys
    // private static adapter = new AngelOneAdapter();
    private static MAX_MARGIN_USAGE = 0.7; // Max usage limit: 70%

    /**
     * Get real-time available margin for user
     */
    static async getAvailableMargin(userId: string, clientcode: string): Promise<{ status: boolean; data?: MarginInfo; message?: string }> {
        try {
            const tokens = await AngelTokensModel.findOne({ userId, clientcode });
            if (!tokens?.jwtToken) {
                return { status: false, message: "No session for RMS check" };
            }

            let user = await User.findById(userId);
            if (!user) {
                user = await Admin.findById(userId);
            }

            // 🚀 [ISSUE 2 FIX] Ensure user-specific API Key is used (No global fallback)
            if (!tokens.apiKey) throw new Error("API Key missing in session");
            
            const decJwtToken = await ensureEncrypted(tokens, 'jwtToken', `user_${userId}_rms_val`);
            const userApiKey = await ensureEncrypted(tokens, 'apiKey', `user_${userId}_rms_check`);
            const dynamicAdapter = new AngelOneAdapter(userApiKey, user?.outgoing_ip);

            const rmsRes = await dynamicAdapter.getRMS(decJwtToken);
            if (rmsRes && rmsRes.status === true) {
                const data = rmsRes.data || {};
                
                // Extract metrics as per SmartAPI response structure (varies slightly)
                const availablecash = Number(data.availablecash || 0);
                const collateral = Number(data.collateral || 0);
                const utilisedspan = Number(data.utilisedspan || 0);

                // usable = cash + collateral - used
                const totalusablemargin = availablecash + collateral - utilisedspan;

                log.info(`RMS_FETCH_SUCCESS [${clientcode}]: Margin=${totalusablemargin}`);
                return {
                    status: true,
                    data: { availablecash, collateral, utilisedspan, totalusablemargin },
                    message: `₹${totalusablemargin.toLocaleString()} Usable`
                };
            }

            log.error(`RMS_FETCH_FAILED: Failed for ${clientcode}`);
            return { status: false, message: "RMS fetch failed from broker" };

        } catch (error: any) {
            log.error(`RMS_EXCEPTION: ${clientcode} - ${error.message}`);
            return { status: false, message: error.message };
        }
    }

    /**
     * Calculate dynamic trade quantity based on available cash and risk percentage
     * trade_size = availablecash * risk_percentage (e.g., 0.05 for 5%)
     * qty = trade_size / (option_price * 1) [simplification]
     */
    static calculateDynamicQuantity(availablecash: number, riskPercent: number, instrumentPrice: number, lotSize: number): number {
        if (instrumentPrice <= 0) return 0;
        
        // 5% risk = 0.05
        const riskAmount = availablecash * (riskPercent / 100);
        
        // How many units can we buy with this riskAmount?
        // Note: For option buying, this is effectively the total investment
        let qty = Math.floor(riskAmount / instrumentPrice);
        
        // Align with lot size
        qty = Math.round(qty / lotSize) * lotSize;
        
        return Math.max(0, qty);
    }

    /**
     * Pre-trade check: Is margin enough for this order?
     */
    static checkMarginSufficient(availableMargin: number, requiredAmount: number): boolean {
        // Max usage logic: Prevent using more than 70% of total usability
        const marginLimit = availableMargin * this.MAX_MARGIN_USAGE;
        
        if (requiredAmount > marginLimit) {
            log.warn(`MARGIN_INSUFFICIENT: Required ${requiredAmount} > Limit ${marginLimit}`);
            return false;
        }
        
        return true;
    }
}
