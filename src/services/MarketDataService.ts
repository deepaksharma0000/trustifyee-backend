import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import AngelTokensModel from "../models/AngelTokens";
import { config } from "../config";
import { log } from "../utils/logger";

const adapter = new AngelOneAdapter();
const lastIndexLtp = new Map<string, number>();

function isInvalidTokenResponse(resp: any) {
    const code = resp?.errorcode || resp?.errorCode;
    const msg = String(resp?.message || "").toLowerCase();
    return code === "AG8001" || msg.includes("invalid token");
}

function isInvalidTokenError(err: any) {
    const msg = String(err?.message || err || "").toLowerCase();
    return msg.includes("ag8001") || msg.includes("invalid token");
}

async function refreshAngelSession(session: any) {
    if (!session?.refreshToken) {
        throw new Error("Angel refreshToken missing. Please login again.");
    }
    const resp = await adapter.generateTokensUsingRefresh(session.refreshToken);
    if (!resp || resp.status === false || !resp.data) {
        log.error("Angel refresh failed:", resp);
        throw new Error(resp?.message || "Angel refresh failed");
    }
    const tokensData = resp.data;
    const jwtToken = tokensData.jwtToken || tokensData.accessToken || tokensData.token;
    const refreshToken = tokensData.refreshToken || session.refreshToken;
    const feedToken = tokensData.websocketToken || tokensData.feedToken || session.feedToken;
    if (!jwtToken) {
        throw new Error("Angel refresh returned no jwtToken");
    }
    await AngelTokensModel.findOneAndUpdate(
        { clientcode: session.clientcode },
        { jwtToken, refreshToken, feedToken, expiresAt: undefined },
        { new: true }
    ).lean();
    return { jwtToken };
}

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

        let resp = await adapter.getLtp(
            session.jwtToken,
            "NSE",
            index.symbol,
            index.token
        );

        if (isInvalidTokenResponse(resp)) {
            log.error(`getLiveIndexLtp (${indexName}) invalid token. Refreshing...`);
            const refreshed = await refreshAngelSession(session);
            resp = await adapter.getLtp(
                refreshed.jwtToken,
                "NSE",
                index.symbol,
                index.token
            );
        }

        if (resp && resp.status === true && resp.data) {
            const ltp = Number(resp.data.ltp);
            if (!Number.isNaN(ltp) && ltp > 0) {
                lastIndexLtp.set(indexName, ltp);
                return ltp;
            }
        }

        log.error(`getLiveIndexLtp (${indexName}) bad response:`, JSON.stringify(resp, null, 2));
        throw new Error(`Failed to fetch ${indexName} LTP from AngelOne`);
    } catch (err: any) {
        if (isInvalidTokenError(err)) {
            try {
                const session: any = await AngelTokensModel.findOne({}).sort({ updatedAt: -1 }).lean();
                if (!session) throw err;
                log.error(`getLiveIndexLtp (${indexName}) retry after refresh...`);
                const refreshed = await refreshAngelSession(session);
                const indexConfig: Record<string, { symbol: string, token: string }> = {
                    "NIFTY": { symbol: config.angelIndexSymbolNifty, token: config.angelIndexTokenNifty },
                    "BANKNIFTY": { symbol: config.angelIndexSymbolBankNifty, token: config.angelIndexTokenBankNifty },
                    "FINNIFTY": { symbol: config.angelIndexSymbolFinNifty, token: config.angelIndexTokenFinNifty }
                };
                const index = indexConfig[indexName];
                const resp = await adapter.getLtp(
                    refreshed.jwtToken,
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
            } catch (refreshErr: any) {
                log.error(`getLiveIndexLtp (${indexName}) refresh failed:`, refreshErr.message || refreshErr);
            }
        }
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
