import { Router } from "express";
import { config } from "../config";
import { MarketStatusService } from "../services/MarketStatusService";
import InstrumentModel from "../models/Instrument";
import log from "../utils/logger";
import { resolveAngelSessionContext } from "../services/AngelSessionContextService";

const router = Router();

router.get("/status", (req, res) => {
    const status = MarketStatusService.getMarketStatus();
    res.json({
        ok: true,
        data: status
    });
});

// 🔥 [NEW] Full Market Quote Area (Depth, LTP, OHLC)
router.get("/full-quote", async (req, res) => {
  const { symbol, exchange } = req.query;
  const exch = (exchange as string || "NSE").toUpperCase();
  const symb = (symbol as string || "").toUpperCase();

  if (!symb) {
    return res.status(400).json({ ok: false, error: "symbol is required" });
  }

  try {
    const sessionUserId = typeof req.query.userId === "string" ? req.query.userId.trim() : "";
    const sessionClientcode = typeof req.query.clientcode === "string" ? req.query.clientcode.trim() : "";

    let symb = (symbol as string || "").toUpperCase();
    let exch = (exchange as string || "NSE").toUpperCase();

    let symboltoken = "";

    // 🔥 1. Check for Common Indices (Hardcoded / Config fallback)
    if (symb === "NIFTY" || symb === "NIFTY50" || symb === "NIFTY 50") {
        symb = "NIFTY";
        exch = "NSE";
        symboltoken = "99926000";
    } else if (symb === "BANKNIFTY" || symb === "NIFTY BANK") {
        symb = "BANKNIFTY";
        exch = "NSE";
        symboltoken = "99926001";
    } else if (symb === "FINNIFTY" || symb === "NIFTY FIN SERVICE") {
        symb = "FINNIFTY";
        exch = "NSE";
        symboltoken = "99926037";
    }

    if (!symboltoken) {
        // 2. Resolve Instrument Token from DB
        const instrument = await InstrumentModel.findOne({
          tradingsymbol: symb,
          exchange: exch
        }).lean();

        if (!instrument) {
            // Try with -EQ for NSE stocks
            const eqSymb = `${symb}-EQ`;
            const eqInstrument = await InstrumentModel.findOne({ tradingsymbol: eqSymb, exchange: exch }).lean();
            
            if (eqInstrument) {
                symboltoken = (eqInstrument as any).symboltoken;
                symb = eqSymb;
            } else {
                return res.status(404).json({ ok: false, error: "Symbol not found in master. Note: Only Options & Indices are currently synced." });
            }
        } else {
            symboltoken = (instrument as any).symboltoken;
        }
    }

    // 2. Get Admin/Recent Token
    const tokens = await resolveAngelSessionContext({
      purpose: "market_status_full_quote",
      userId: sessionUserId || undefined,
      clientcode: sessionClientcode || config.dataClientCode || undefined,
      allowGlobalFallback: false,
      requireJwt: true,
    });
    if (!tokens?.jwtToken) {
      return res.status(403).json({ ok: false, error: "No active broker session found. Please login to AngelOne." });
    }

    // 3. Fetch Full Quote using the session owner's API key
    if (!tokens?.userId) return res.status(403).json({ ok: false, error: "Invalid session owner" });
    const { createAngelAdapter } = await import('../utils/broker');
    const adapter = await createAngelAdapter(tokens.userId.toString());
    const result = await adapter.getMarketData(tokens.jwtToken, "FULL", { [exch]: [symboltoken] });

    if (result?.status !== 200) {
       return res.status(400).json({ ok: false, error: result.data?.message || "Failed to fetch quote from broker" });
    }

    // Success
    const quote = result?.data?.[0] || result?.[0] || result;
    return res.json({ ok: true, data: quote });

  } catch (error: any) {
    log.error("Full Quote Error:", error.message);
    return res.status(500).json({ ok: false, error: error.message || "Internal Server Error" });
  }
});

// 🔥 [NEW] Historical Candle Data (For Charts, Analysis, Indicators)
router.get("/historical", async (req, res) => {
  const { symbol, exchange, interval, fromdate, todate } = req.query;
  const exch = (exchange as string || "NSE").toUpperCase();
  let symb = (symbol as string || "").toUpperCase();
  const inter = (interval as string || "ONE_DAY").toUpperCase();

  if (!symb) return res.status(400).json({ ok: false, error: "symbol is required" });

  try {
    const sessionUserId = typeof req.query.userId === "string" ? req.query.userId.trim() : "";
    const sessionClientcode = typeof req.query.clientcode === "string" ? req.query.clientcode.trim() : "";

    // 1. Resolve Token (Index or DB)
    let symboltoken = "";
    if (symb === "NIFTY" || symb === "NIFTY50") {
        symboltoken = "99926000"; symb = "NIFTY";
    } else if (symb === "BANKNIFTY") {
        symboltoken = "99926001";
    } else {
        const instrument = await InstrumentModel.findOne({ tradingsymbol: symb, exchange: exch }).lean();
        if (!instrument) {
            // Try -EQ fallback
            const eq = await InstrumentModel.findOne({ tradingsymbol: `${symb}-EQ`, exchange: exch }).lean();
            if (eq) symboltoken = (eq as any).symboltoken;
            else return res.status(404).json({ ok: false, error: "Symbol not found for historical fetch" });
        } else {
            symboltoken = (instrument as any).symboltoken;
        }
    }

    // 2. Token Check
    const tokens = await resolveAngelSessionContext({
      purpose: "market_status_historical",
      userId: sessionUserId || undefined,
      clientcode: sessionClientcode || config.dataClientCode || undefined,
      allowGlobalFallback: false,
      requireJwt: true,
    });
    if (!tokens?.jwtToken) return res.status(403).json({ ok: false, error: "Broker session inactive" });

    // 3. Fetch from AngelOne
    if (!tokens?.userId) return res.status(403).json({ ok: false, error: "Broker user mapping lost" });
    const { createAngelAdapter } = await import('../utils/broker');
    const adapter = await createAngelAdapter(tokens.userId.toString());
    const path = "/rest/secure/angelbroking/historical/v1/getCandleData";
    const body = {
        exchange: exch,
        symboltoken,
        interval: inter,
        fromdate: fromdate || "2024-01-01 09:15",
        todate: todate || "2024-12-31 15:30"
    };

    const result = await adapter.authPost(tokens.jwtToken, path, body);

    if (result?.status !== 200) {
       return res.status(400).json({ ok: false, error: result.data?.message || "Historical fetch failed" });
    }

    return res.json({ ok: true, data: result?.data || [] });

  } catch (error: any) {
    log.error("Historical Error:", error.message);
    return res.status(500).json({ ok: false, error: error.message || "Internal Server Error" });
  }
});

export default router;
