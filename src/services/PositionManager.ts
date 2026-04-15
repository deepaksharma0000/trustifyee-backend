import { Position } from "../models/Position.model";
import { getInstrumentLtp } from "./MarketDataService";
import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import { log } from "../utils/logger";
import InstrumentModel from "../models/Instrument";
import AngelTokensModel from "../models/AngelTokens";
import User from "../models/User";

// Removed global adapter to prevent startup crash
// const adapter = new AngelOneAdapter();

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

                    // 🚀 [BROKER AWARE EXIT]
                    const user = await User.findById(p.userId).lean() as any;
                    const broker = user?.broker || "AngelOne";

                    if (broker === "AliceBlue") {
                        const { placeOrderForClient } = await import("./OrderService");
                        const exitSide = pos.side === "BUY" ? "SELL" : "BUY";
                        const aliceRes = await placeOrderForClient(p.userId, p.clientcode, {
                            exchange: p.exchange,
                            tradingsymbol: p.tradingsymbol,
                            side: exitSide,
                            transactiontype: exitSide,
                            quantity: p.quantity,
                            ordertype: "MARKET",
                            symboltoken: p.symboltoken,
                            producttype: (p.productType || "INTRADAY") as any
                        });

                        if (aliceRes && aliceRes.status === true) {
                            p.status = "CLOSED";
                            p.exitPrice = ltp;
                            p.exitAt = new Date();
                            p.exitOrderId = aliceRes.data?.orderid || "ALICE-EXIT";
                            await p.save();
                            log.info(`✅ Auto-Exit Success (Alice): ${p.tradingsymbol}`);
                        } else {
                            log.error(`❌ Auto-Exit Failed (Alice): ${aliceRes?.message}`);
                        }
                    } else {
                        // 😇 [DEFAULT / ANGELONE FLOW]
                        const tokens = await AngelTokensModel.findOne(p.userId ? { userId: p.userId, clientcode: p.clientcode } : { clientcode: p.clientcode }).lean() as any;
                        if (tokens?.jwtToken) {
                            await executeExit(p, tokens.jwtToken, exitReason);
                        } else {
                            log.error(`Cannot auto-exit ${p.tradingsymbol}: No token for ${p.clientcode}`);
                        }
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

async function executeExit(position: any, _jwtToken: string, reason: string) {
    try {
        const exitSide = position.side === "BUY" ? "SELL" : "BUY";

        // 🚀 [COMPLIANCE FIX] Generate an EXIT signal via SignalService
        const { SignalService } = await import("./SignalService");
        const signal = await SignalService.createSignal({
            symbol: position.tradingsymbol,
            exchange: position.exchange,
            side: exitSide,
            tradingsymbol: position.tradingsymbol,
            price: 0, 
            quantity: position.quantity,
            strategy: position.strategy || "WATCHDOG_EXIT",
            signalType: "EXIT",
        });

        if (signal) {
            log.info(`✅ Watchdog: Push EXIT signal for ${position.tradingsymbol} (${reason})`);
            // We don't mark as CLOSED here because the user device needs to execute it first.
            // However, to prevent signal spamming, we might want to mark it as 'EXIT_SIGNALED' 
            // but for now, the 60s dedup in SignalService.createSignal handles rapid loops.
        }
    } catch (err: any) {
        log.error(`❌ Watchdog Exit Signal Error: ${err.message}`);
    }
}
