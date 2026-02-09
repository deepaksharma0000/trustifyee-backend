// src/routes/strategyHelper.routes.ts
import { Router } from "express";
import { auth } from "../middleware/auth.middleware";
import { resolveStrategyLegs, getAllStrategies } from "../services/StrategyEngine";
import { log } from "../utils/logger";

const router = Router();

/**
 * Get all available strategies
 */
router.get("/list", auth, async (_req, res) => {
    try {
        const strategies = getAllStrategies();
        return res.json({ ok: true, strategies });
    } catch (err: any) {
        log.error("Get strategies error:", err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * Auto-select strikes based on strategy
 * This endpoint helps admin by suggesting strikes based on strategy logic
 */
router.post("/auto-select", auth, async (req, res) => {
    try {
        const { symbol, expiry, strategy } = req.body;

        if (!symbol || !expiry || !strategy) {
            return res.status(400).json({
                ok: false,
                error: "symbol, expiry, and strategy are required",
            });
        }

        log.info(`Auto-selecting strikes for ${strategy} on ${symbol} ${expiry}`);

        // Resolve strategy legs
        const legs = await resolveStrategyLegs({
            symbol,
            expiry: new Date(expiry),
            strategyName: strategy,
            lotSize: 1,
        });

        // Transform to frontend-friendly format
        const selectedOptions = legs.map((leg) => ({
            symboltoken: leg.symboltoken,
            tradingsymbol: leg.tradingsymbol,
            expiry: leg.expiry,
            optiontype: leg.optionType,
            strike: leg.strike,
            side: leg.side,
            quantity: leg.quantity,
        }));

        log.info(`✅ Auto-selected ${selectedOptions.length} options for ${strategy}`);

        return res.json({
            ok: true,
            strategy,
            selectedOptions,
            message: `Auto-selected ${selectedOptions.length} options based on ${strategy} strategy`,
        });
    } catch (err: any) {
        log.error("Auto-select error:", err.message);
        return res.status(500).json({
            ok: false,
            error: err.message || "Failed to auto-select strikes",
        });
    }
});

export default router;
