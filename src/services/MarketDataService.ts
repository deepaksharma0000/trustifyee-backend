import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import AngelTokensModel from "../models/AngelTokens";
import { config } from "../config";
import { log } from "../utils/logger";

const adapter = new AngelOneAdapter();
const lastIndexLtp = new Map<string, number>();

export async function getLiveIndexLtp(indexName: "NIFTY" | "BANKNIFTY" | "FINNIFTY" = "NIFTY"): Promise<number> {
    try {
        const session: any = await AngelTokensModel.findOne({}).sort({ updatedAt: -1 }).lean();

        if (!session || !session.jwtToken) {
            throw new Error(`No active AngelOne session for ${indexName} LTP`);
        }

        // Index Config
        const indexConfig: Record<string, { symbol: string, token: string }> = {
            "NIFTY": { symbol: config.angelIndexSymbolNifty, token: config.angelIndexTokenNifty },
            "BANKNIFTY": { symbol: config.angelIndexSymbolBankNifty, token: config.angelIndexTokenBankNifty },
            "FINNIFTY": { symbol: config.angelIndexSymbolFinNifty, token: config.angelIndexTokenFinNifty }
        };

        const index = indexConfig[indexName];

        const resp = await adapter.getLtp(
            session.jwtToken,
            "NSE",
            index.symbol,
            index.token
        );

        if (resp && resp.status === true && resp.data) {
            const ltp = Number(resp.data.ltp);
            if (!Number.isNaN(ltp) && ltp > 0) {
                lastIndexLtp.set(indexName, ltp);
                return ltp;
            }
        }

        throw new Error(`Failed to fetch ${indexName} LTP from AngelOne`);
    } catch (err: any) {
        log.error(`getLiveIndexLtp (${indexName}) error:`, err.message || err);
        throw err;
    }
}

export function getLastIndexLtp(indexName: "NIFTY" | "BANKNIFTY" | "FINNIFTY" = "NIFTY") {
    return lastIndexLtp.get(indexName) || 0;
}

// Keep backward compatibility for now
export async function getLiveNiftyLtp(): Promise<number> {
    return getLiveIndexLtp("NIFTY");
}
