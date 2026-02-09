// src/services/StrategyEngine.ts
import { log } from "../utils/logger";
import { getLiveIndexLtp } from "./MarketDataService";
import { getATMStrike } from "../utils/optionUtils";
import InstrumentModel from "../models/Instrument";

export type StrategyName = "Alpha" | "Beta" | "Gamma" | "Delta" | "Straddle" | "Strangle" | "IronCondor" | "BullCallSpread" | "BearPutSpread";

export interface StrategyConfig {
    name: StrategyName;
    description: string;
    legs: StrategyLeg[];
    riskProfile: "LOW" | "MEDIUM" | "HIGH";
    defaultStopLoss: number; // percentage
    defaultTarget: number; // percentage
    maxLossPercent: number; // max daily loss
}

export interface StrategyLeg {
    side: "BUY" | "SELL";
    optionType: "CE" | "PE";
    strikeOffset: number; // offset from ATM (0 = ATM, +1 = 1 strike OTM, -1 = 1 strike ITM)
    quantity: number; // lot multiplier
}

export interface StrategyExecutionParams {
    symbol: "NIFTY" | "BANKNIFTY" | "FINNIFTY";
    expiry: Date;
    strategyName: StrategyName;
    lotSize?: number; // default 1
}

export interface ResolvedStrategyLeg {
    side: "BUY" | "SELL";
    optionType: "CE" | "PE";
    tradingsymbol: string;
    strike: number;
    symboltoken: string;
    quantity: number;
    expiry: Date;
}

// ============================================
// STRATEGY DEFINITIONS (Production Ready)
// ============================================

export const STRATEGY_CONFIGS: Record<StrategyName, StrategyConfig> = {
    Alpha: {
        name: "Alpha",
        description: "ATM Straddle - Buy both CE and PE at ATM for high volatility",
        legs: [
            { side: "BUY", optionType: "CE", strikeOffset: 0, quantity: 1 },
            { side: "BUY", optionType: "PE", strikeOffset: 0, quantity: 1 },
        ],
        riskProfile: "HIGH",
        defaultStopLoss: 30,
        defaultTarget: 50,
        maxLossPercent: 3,
    },

    Beta: {
        name: "Beta",
        description: "OTM Strangle - Buy OTM CE and PE for lower cost, higher risk",
        legs: [
            { side: "BUY", optionType: "CE", strikeOffset: 2, quantity: 1 },
            { side: "BUY", optionType: "PE", strikeOffset: -2, quantity: 1 },
        ],
        riskProfile: "MEDIUM",
        defaultStopLoss: 40,
        defaultTarget: 60,
        maxLossPercent: 2,
    },

    Gamma: {
        name: "Gamma",
        description: "Sell ATM Straddle - High premium collection, unlimited risk",
        legs: [
            { side: "SELL", optionType: "CE", strikeOffset: 0, quantity: 1 },
            { side: "SELL", optionType: "PE", strikeOffset: 0, quantity: 1 },
        ],
        riskProfile: "HIGH",
        defaultStopLoss: 20,
        defaultTarget: 30,
        maxLossPercent: 5,
    },

    Delta: {
        name: "Delta",
        description: "Bull Call Spread - Buy ATM CE, Sell OTM CE (Limited risk/reward)",
        legs: [
            { side: "BUY", optionType: "CE", strikeOffset: 0, quantity: 1 },
            { side: "SELL", optionType: "CE", strikeOffset: 2, quantity: 1 },
        ],
        riskProfile: "LOW",
        defaultStopLoss: 25,
        defaultTarget: 40,
        maxLossPercent: 1.5,
    },

    Straddle: {
        name: "Straddle",
        description: "Classic ATM Straddle - Neutral strategy for big moves",
        legs: [
            { side: "BUY", optionType: "CE", strikeOffset: 0, quantity: 1 },
            { side: "BUY", optionType: "PE", strikeOffset: 0, quantity: 1 },
        ],
        riskProfile: "HIGH",
        defaultStopLoss: 30,
        defaultTarget: 50,
        maxLossPercent: 3,
    },

    Strangle: {
        name: "Strangle",
        description: "OTM Strangle - Lower cost than straddle",
        legs: [
            { side: "BUY", optionType: "CE", strikeOffset: 1, quantity: 1 },
            { side: "BUY", optionType: "PE", strikeOffset: -1, quantity: 1 },
        ],
        riskProfile: "MEDIUM",
        defaultStopLoss: 35,
        defaultTarget: 55,
        maxLossPercent: 2.5,
    },

    IronCondor: {
        name: "IronCondor",
        description: "Sell OTM Strangle + Buy further OTM protection",
        legs: [
            { side: "SELL", optionType: "CE", strikeOffset: 1, quantity: 1 },
            { side: "BUY", optionType: "CE", strikeOffset: 3, quantity: 1 },
            { side: "SELL", optionType: "PE", strikeOffset: -1, quantity: 1 },
            { side: "BUY", optionType: "PE", strikeOffset: -3, quantity: 1 },
        ],
        riskProfile: "LOW",
        defaultStopLoss: 40,
        defaultTarget: 50,
        maxLossPercent: 2,
    },

    BullCallSpread: {
        name: "BullCallSpread",
        description: "Bullish strategy - Buy ITM CE, Sell OTM CE",
        legs: [
            { side: "BUY", optionType: "CE", strikeOffset: -1, quantity: 1 },
            { side: "SELL", optionType: "CE", strikeOffset: 2, quantity: 1 },
        ],
        riskProfile: "LOW",
        defaultStopLoss: 25,
        defaultTarget: 40,
        maxLossPercent: 1.5,
    },

    BearPutSpread: {
        name: "BearPutSpread",
        description: "Bearish strategy - Buy ITM PE, Sell OTM PE",
        legs: [
            { side: "BUY", optionType: "PE", strikeOffset: 1, quantity: 1 },
            { side: "SELL", optionType: "PE", strikeOffset: -2, quantity: 1 },
        ],
        riskProfile: "LOW",
        defaultStopLoss: 25,
        defaultTarget: 40,
        maxLossPercent: 1.5,
    },
};

// ============================================
// STRATEGY EXECUTION ENGINE
// ============================================

function formatIstDate(date: Date) {
    return date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function getIstDayRange(dateStr: string) {
    const start = new Date(`${dateStr}T00:00:00+05:30`);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
}

function getNearestStrike(strikes: number[], atm: number) {
    if (!strikes.length) return 0;
    return strikes.reduce((prev, curr) =>
        Math.abs(curr - atm) < Math.abs(prev - atm) ? curr : prev
    );
}

/**
 * Resolve strategy legs to actual instruments
 */
export async function resolveStrategyLegs(
    params: StrategyExecutionParams
): Promise<ResolvedStrategyLeg[]> {
    const { symbol, expiry, strategyName, lotSize = 1 } = params;

    const config = STRATEGY_CONFIGS[strategyName];
    if (!config) {
        throw new Error(`Unknown strategy: ${strategyName}`);
    }

    // Get current LTP
    const ltp = await getLiveIndexLtp(symbol);
    if (ltp <= 0) {
        log.warn(`Strategy ${strategyName}: Live LTP unavailable for ${symbol}. Skipping resolution.`);
        return [];
    }

    const atmStrike = getATMStrike(ltp);
    log.info(`Strategy ${strategyName}: LTP=${ltp}, ATM=${atmStrike}`);

    // Get expiry range
    const expiryStr = formatIstDate(expiry);
    const expiryRange = getIstDayRange(expiryStr);

    // Get all available strikes for this expiry
    const baseQuery = {
        name: symbol,
        instrumenttype: "OPTIDX",
        expiry: {
            $gte: expiryRange.start,
            $lt: expiryRange.end,
        },
    };

    const strikes: number[] = await InstrumentModel.distinct("strike", baseQuery);
    if (!strikes.length) {
        throw new Error(`No strikes found for ${symbol} on ${expiryStr}`);
    }

    const sortedStrikes = strikes.sort((a, b) => a - b);
    const atmIndex = sortedStrikes.findIndex((s) => s === getNearestStrike(sortedStrikes, atmStrike));

    if (atmIndex === -1) {
        throw new Error(`ATM strike not found in available strikes`);
    }

    // Resolve each leg
    const resolvedLegs: ResolvedStrategyLeg[] = [];

    for (const leg of config.legs) {
        const targetIndex = atmIndex + leg.strikeOffset;

        if (targetIndex < 0 || targetIndex >= sortedStrikes.length) {
            throw new Error(
                `Strike offset ${leg.strikeOffset} out of range for ${leg.optionType}`
            );
        }

        const targetStrike = sortedStrikes[targetIndex];

        // Find instrument
        const instrument: any = await InstrumentModel.findOne({
            ...baseQuery,
            strike: targetStrike,
            optiontype: leg.optionType,
        })
            .select("tradingsymbol strike optiontype expiry symboltoken")
            .lean();

        if (!instrument) {
            throw new Error(
                `Instrument not found: ${symbol} ${targetStrike} ${leg.optionType} ${expiryStr}`
            );
        }

        resolvedLegs.push({
            side: leg.side,
            optionType: leg.optionType,
            tradingsymbol: instrument.tradingsymbol || "",
            strike: targetStrike,
            symboltoken: instrument.symboltoken || "",
            quantity: leg.quantity * lotSize,
            expiry: instrument.expiry || expiry,
        });

        log.info(
            `Resolved leg: ${leg.side} ${leg.optionType} ${targetStrike} (${instrument.tradingsymbol})`
        );
    }

    return resolvedLegs;
}

/**
 * Get strategy configuration
 */
export function getStrategyConfig(strategyName: StrategyName): StrategyConfig {
    const config = STRATEGY_CONFIGS[strategyName];
    if (!config) {
        throw new Error(`Unknown strategy: ${strategyName}`);
    }
    return config;
}

/**
 * Validate if strategy can be executed
 */
export function validateStrategy(strategyName: StrategyName): {
    valid: boolean;
    error?: string;
} {
    const config = STRATEGY_CONFIGS[strategyName];
    if (!config) {
        return { valid: false, error: `Unknown strategy: ${strategyName}` };
    }

    if (config.legs.length === 0) {
        return { valid: false, error: "Strategy has no legs defined" };
    }

    return { valid: true };
}

/**
 * Get all available strategies
 */
export function getAllStrategies(): StrategyConfig[] {
    return Object.values(STRATEGY_CONFIGS);
}
