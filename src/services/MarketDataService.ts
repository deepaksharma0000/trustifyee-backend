import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import AngelTokensModel from "../models/AngelTokens";
import { log } from "../utils/logger";

const adapter = new AngelOneAdapter();

export async function getLiveIndexLtp(indexName: "NIFTY" | "BANKNIFTY" | "FINNIFTY" = "NIFTY"): Promise<number> {
    try {
        const session: any = await AngelTokensModel.findOne({}).sort({ updatedAt: -1 }).lean();

        if (!session || !session.jwtToken) {
            log.error(`No active AngelOne session found for Live ${indexName} LTP`);
            return 0;
        }

        // Index Config
        const indexConfig: Record<string, { symbol: string, token: string }> = {
            "NIFTY": { symbol: "Nifty 50", token: "99926000" },
            "BANKNIFTY": { symbol: "Nifty Bank", token: "99926001" },
            "FINNIFTY": { symbol: "Nifty Fin Service", token: "99926037" }
        };

        const config = indexConfig[indexName];

        const resp = await adapter.getLtp(
            session.jwtToken,
            "NSE",
            config.symbol,
            config.token
        );

        if (resp && resp.status === true && resp.data) {
            return Number(resp.data.ltp);
        }

        log.error(`Failed to fetch ${indexName} LTP from AngelOne`, resp);
        return 0;
    } catch (err: any) {
        log.error(`getLiveIndexLtp (${indexName}) error:`, err.message || err);
        return 0;
    }
}

// Keep backward compatibility for now
export async function getLiveNiftyLtp(): Promise<number> {
    return getLiveIndexLtp("NIFTY");
}
