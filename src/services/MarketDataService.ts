import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import AngelTokensModel from "../models/AngelTokens";
import { log } from "../utils/logger";

const adapter = new AngelOneAdapter();

export async function getLiveNiftyLtp(): Promise<number> {
    try {
        // 1. Get a valid session from DB
        const session: any = await AngelTokensModel.findOne({}).sort({ updatedAt: -1 }).lean();

        if (!session || !session.jwtToken) {
            log.error("No active AngelOne session found for Live LTP");
            return 0;
        }

        // 2. Fetch LTP for Nifty 50 Index
        // Exchange: NSE, TradingSymbol: Nifty 50, SymbolToken: 99926000
        const resp = await adapter.getLtp(
            session.jwtToken,
            "NSE",
            "Nifty 50",
            "99926000"
        );

        if (resp && resp.status === true && resp.data) {
            return Number(resp.data.ltp);
        }

        log.error("Failed to fetch Nifty LTP from AngelOne", resp);
        return 0;
    } catch (err: any) {
        log.error("getLiveNiftyLtp error:", err.message || err);
        return 0;
    }
}
