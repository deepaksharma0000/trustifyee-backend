import { Position } from "../models/Position.model";
import { getInstrumentLtp } from "./MarketDataService";
import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import { log } from "../utils/logger";
import InstrumentModel from "../models/Instrument";
import AngelTokensModel from "../models/AngelTokens";

const adapter = new AngelOneAdapter();

/**
 * WATCHDOG SERVICE
 * Checks open positions every X seconds.
 */
export const startPositionWatchdog = () => {
    log.info("🔥 Starting Position Watchdog Service...");

    setInterval(async () => {
        try {
            await checkAndManagePositions();
        } catch (err: any) {
            log.error("Watchdog Loop Error:", err.message);
        }
    }, 15000); // Check every 15 seconds
};

async function checkAndManagePositions() {
    // 1. Find all OPEN positions
    const positions = await Position.find({ status: "OPEN" });

    if (positions.length === 0) return;

    log.debug(`Watchdog: Checking ${positions.length} positions...`);

    for (const p of positions) {
        try {
            let currentSymbolToken = (p as any).symboltoken;
            if (!currentSymbolToken) {
                const inst = await InstrumentModel.findOne({ tradingsymbol: p.tradingsymbol, exchange: p.exchange }).lean() as any;
                currentSymbolToken = inst?.symboltoken;
            }

            if (!currentSymbolToken) continue;

            // Fetch LTP (Throttled & Cached via MarketDataService)
            const ltp = await getInstrumentLtp(p.exchange, p.tradingsymbol, currentSymbolToken);

            if (!ltp || ltp <= 0) continue;

            const pos: any = p;
            if (pos.stopLossPrice || pos.targetPrice) {
                const isBuy = pos.side === "BUY";
                let limitHit = false;
                let exitReason = "";

                if (isBuy) {
                    if (pos.stopLossPrice && ltp <= pos.stopLossPrice) {
                        limitHit = true;
                        exitReason = "SL Hit";
                    } else if (pos.targetPrice && ltp >= pos.targetPrice) {
                        limitHit = true;
                        exitReason = "Target Hit";
                    }
                } else {
                    if (pos.stopLossPrice && ltp >= pos.stopLossPrice) {
                        limitHit = true;
                        exitReason = "SL Hit";
                    } else if (pos.targetPrice && ltp <= pos.targetPrice) {
                        limitHit = true;
                        exitReason = "Target Hit";
                    }
                }

                if (limitHit) {
                    log.info(`🚀 Auto-Exit Triggered: ${p.tradingsymbol} | reason: ${exitReason} | LTP: ${ltp} | SL: ${pos.stopLossPrice} | TGT: ${pos.targetPrice}`);

                    // We need a session token for execution
                    const tokens = await AngelTokensModel.findOne({ clientcode: p.clientcode }).lean() as any;
                    if (tokens?.jwtToken) {
                        await executeExit(p, tokens.jwtToken, exitReason);
                    } else {
                        log.error(`Cannot auto-exit ${p.tradingsymbol}: No token for ${p.clientcode}`);
                    }
                }
            }

        } catch (e: any) {
            if (e.message?.includes('429') || e.message?.includes('403')) {
                log.warn('Watchdog hit rate limit via MarketDataService. Skipping rest of run.');
                break;
            }
            log.error(`Error checking position ${(p as any).orderid}:`, e.message);
        }
    }
}

async function executeExit(position: any, jwtToken: string, reason: string) {
    try {
        const exitSide = position.side === "BUY" ? "SELL" : "BUY";

        // Place Market Exit
        const apiRes = await adapter.placeOrder(jwtToken, {
            exchange: position.exchange,
            tradingsymbol: position.tradingsymbol,
            transactiontype: exitSide,
            quantity: position.quantity,
            ordertype: "MARKET",
            symboltoken: position.symboltoken,
            producttype: "INTRADAY" // or carry over from position
        });

        if (apiRes && (apiRes.status === true || apiRes.status === "success")) {
            // Update DB
            position.status = "CLOSED";
            position.exitPrice = 0; // we don't know exact execution price yet, need orderbook fetch or assume LTP
            position.exitAt = new Date();
            position.exitOrderId = apiRes.data?.orderid;
            await position.save();
            log.info(`✅ Auto-Exit Success: ${position.tradingsymbol}`);
        } else {
            log.error(`❌ Auto-Exit Failed API: ${JSON.stringify(apiRes)}`);
        }
    } catch (err: any) {
        log.error(`❌ Auto-Exit Exception: ${err.message}`);
    }
}
