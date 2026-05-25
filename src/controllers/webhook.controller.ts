import { Request, Response } from "express";
import log from "../utils/logger";
import { getLiveNiftyLtp } from "../services/MarketDataService";
import { getNiftyOptionChain } from "../services/NiftyOptionService";
import User from "../models/User";
import { placeOrderForClient } from "../services/OrderService";
import { Position } from "../models/Position.model";
import { decrypt } from "../utils/encryption";
import { parseAngelOrderPlacement } from "../utils/angelResponseParser";

export const handleWebhookSignal = async (req: Request, res: Response) => {
    try {
        const { action, symbol, secret } = req.body;

        // 1. Basic Auth (Optional but recommended)
        // if (secret !== process.env.WEBHOOK_SECRET) {
        //   return res.status(401).json({ ok: false, message: "Unauthorized signal" });
        // }

        log.info(`🚀 Webhook Received: ${action} for ${symbol}`);

        if (symbol !== "NIFTY") {
            return res.status(400).json({ ok: false, message: "Only NIFTY supported for now" });
        }

        // 2. Fetch Live LTP & ATM Strike
        const ltp = await getLiveNiftyLtp();
        if (ltp <= 0) throw new Error("Could not fetch live LTP for webhook");

        const chain = await getNiftyOptionChain(ltp);
        const atmStrike = chain.atmStrike;

        // 3. Decide CE or PE based on action
        // "BUY" signal from TradingView usually means bullish -> Buy CE
        // "SELL" signal from TradingView usually means bearish -> Buy PE
        const optionType = action.toUpperCase() === "BUY" ? "CE" : "PE";
        const targetOption = chain.options.find(o => o.strike === atmStrike && o.optiontype === optionType);

        if (!targetOption) {
            throw new Error(`Could not find ATM ${optionType} for strike ${atmStrike}`);
        }

        log.info(`🎯 Target Instrument: ${targetOption.tradingsymbol}`);

        // 4. Find all Active Users
        const activeUsers = await User.find({ trading_status: "enabled", broker: "AngelOne" });

        if (activeUsers.length === 0) {
            log.warn("No active users found for auto-trading");
            return res.json({ ok: true, message: "No active users" });
        }

        // 5. Fire Orders for all users
        const results = await Promise.all(activeUsers.map(async (user) => {
            try {
                let clientcode = (user as any).client_key || (user as any).panel_client_key;
                if (!clientcode) return { user: user.user_name, status: "No client code" };

                // Decrypt clientcode for token lookup
                try {
                    clientcode = decrypt(clientcode);
                } catch (e) {
                    log.warn(`Failed to decrypt client_key for webhook user ${user.user_name}`);
                }

                const resp = await placeOrderForClient(user._id, clientcode, {
                    exchange: "NFO",
                    tradingsymbol: targetOption.tradingsymbol,
                    side: "BUY",
                    quantity: 1, // You can make this dynamic based on user settings later
                    ordertype: "MARKET",
                    transactiontype: "BUY",
                    symboltoken: targetOption.symboltoken
                });

                const parsed = parseAngelOrderPlacement(resp);
                if (resp && resp.status === 200 && parsed.accepted) {
                    const orderid = parsed.brokerOrderId || parsed.uniqueOrderId || `WEBHOOK-${Date.now()}`;
                    // Save to Database
                    await Position.create({
                        userId: user._id,
                        clientcode,
                        orderid,
                        tradingsymbol: targetOption.tradingsymbol,
                        symboltoken: targetOption.symboltoken,
                        exchange: "NFO",
                        side: "BUY",
                        quantity: 1,
                        entryPrice: Number(resp.data.ltp) || 0,
                        status: "OPEN"
                    });
                    return { user: user.user_name, status: "Success", orderid };
                } else {
                    return {
                        user: user.user_name,
                        status: "Failed",
                        error: parsed.rejectionReason || parsed.brokerMessage || resp?.message || "Broker rejected order",
                        errorCode: parsed.errorCode,
                    };
                }
            } catch (err: any) {
                return { user: user.user_name, status: "Error", error: err.message };
            }
        }));

        res.json({ ok: true, results });

    } catch (err: any) {
        log.error("Webhook processing failed:", err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
};
