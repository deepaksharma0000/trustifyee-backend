import express from "express";
import { UpstoxAdapter } from "../adapters/UpstoxAdapter";
import UpstoxTokensModel from "../models/UpstoxTokens";
import { log } from "../utils/logger";

const router = express.Router();
const adapter = new UpstoxAdapter();

async function getAccessToken(userId: string) {
  const doc = await UpstoxTokensModel.findOne({ userId }).exec();
  if (!doc || !doc.accessToken) throw new Error("No active Upstox session for userId");
  return doc.accessToken;
}
router.post("/place-option", async (req, res) => {
  try {
    const {
      userId,
      instrument_key,
      option_type,
      strike_price,
      expiry,
      instrument_token: providedToken,
      transaction_type = "BUY",
      quantity = 1,
      product = "D",
      order_type = "MARKET",
      validity = "DAY",
      is_amo = false,
      tag = "option-auto"
    } = req.body;

    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });
    if (!instrument_key && (!providedToken || providedToken === "NA")) {
      return res.status(400).json({ ok: false, error: "instrument_key or instrument_token required" });
    }

    const accessToken = await getAccessToken(userId);

    // If providedToken present and valid -> place order directly
    if (providedToken && providedToken !== "NA") {
      const orderPayload = {
        instrument_token: providedToken,
        quantity,
        product,
        validity,
        price: 0,
        order_type,
        transaction_type,
        is_amo,
        tag
      };
      const resp = await adapter.placeOrder(accessToken, orderPayload);
      return res.json({ ok: true, usedProvidedToken: true, orderPayload, upstox: resp });
    }

    // Fetch contract/option chain
    const rawResp = await adapter.fetchOptionContract(accessToken, instrument_key);
    const data = rawResp?.data ?? rawResp;

    log.debug("place-option rawResp length/case", { instrument_key, hasData: !!data });

    if (!data) {
      return res.status(500).json({ ok: false, error: "Empty response from Upstox" });
    }

    // Collect candidate items (look for common containers)
    const candidates: any[] = [];
    if (Array.isArray(data)) {
      candidates.push(...data);
    } else if (data.contracts && Array.isArray(data.contracts)) {
      candidates.push(...data.contracts);
    } else if (data.options && Array.isArray(data.options)) {
      candidates.push(...data.options);
    } else if (data.items && Array.isArray(data.items)) {
      candidates.push(...data.items);
    } else {
      // single object - include it and nested arrays if present
      candidates.push(data);
      for (const k of Object.keys(data)) {
        if (Array.isArray((data as any)[k])) candidates.push(...(data as any)[k]);
      }
    }

    // Normalize and extract token from raw fields: prefer raw.instrument_key, else construct from exchange_token
    const normalized = candidates.map((it: any) => {
      const raw = it.raw ?? it;
      // primary token candidates:
      //  - raw.instrument_key (e.g. "NSE_FO|64831")
      //  - raw.exchange_token (e.g. "64831") -> fallback to `${raw.segment ?? 'NSE_FO'}|${exchange_token}`
      const rawInstrumentKey = raw?.instrument_key ?? raw?.instrumentKey ?? null;
      const exchangeToken = raw?.exchange_token ?? raw?.exchangeToken ?? raw?.exchange_token_id ?? null;
      let inferredToken: string | null = null;
      if (rawInstrumentKey) {
        inferredToken = rawInstrumentKey;
      } else if (exchangeToken) {
        // prefer segment if present (raw.segment often 'NSE_FO'), otherwise try to use 'NSE_FO'
        const seg = (raw?.segment && raw.segment.includes("|")) ? raw.segment.split("|")[0] : (raw?.segment ?? "NSE_FO");
        // If raw.instrument_key is missing but underlying_key exists, try to use that exchange prefix
        // Typical format: "NSE_FO|64831"
        inferredToken = `${seg}|${exchangeToken}`;
      }

      return {
        raw,
        instrument_token: it?.instrument_token ?? it?.token ?? it?.token_id ?? inferredToken ?? null,
        option_type: (raw?.instrument_type ?? raw?.option_type ?? raw?.opt_type ?? "").toString(),
        tradingsymbol: raw?.trading_symbol ?? raw?.tradingsymbol ?? raw?.symbol ?? it?.tradingsymbol ?? null,
        strike_price: Number(raw?.strike_price ?? raw?.strike ?? it?.strike_price ?? it?.strike ?? NaN),
        expiry: raw?.expiry ? new Date(raw.expiry) : (raw?.expiry_date ? new Date(raw.expiry_date) : null)
      };
    });

    // Filter out entries without token
    let filtered = normalized.filter(n => !!n.instrument_token);

    if (option_type) {
      const ot = option_type.toString().toUpperCase();
      filtered = filtered.filter(n => (n.option_type ?? "").toUpperCase() === ot);
    }

    if (strike_price !== undefined && strike_price !== null) {
      filtered = filtered.filter(n => !Number.isNaN(n.strike_price) && Number(n.strike_price) === Number(strike_price));
    }

    if (expiry) {
      const want = new Date(expiry);
      filtered = filtered.filter(n => n.expiry && n.expiry.toISOString().slice(0,10) === want.toISOString().slice(0,10));
    }

    // pick best candidate
    let picked = filtered.length > 0 ? filtered[0] : (normalized.length > 0 ? normalized.find(n => !!n.instrument_token) : null);

    if (!picked || !picked.instrument_token) {
      return res.status(400).json({
        ok: false,
        error: "instrument_token missing in Upstox data or no contract matched",
        debug: {
          provided: { option_type, strike_price, expiry },
          candidatesCount: normalized.length,
          sampleCandidates: normalized.slice(0, 6).map((n: any) => ({
            instrument_token: n.instrument_token,
            tradingsymbol: n.tradingsymbol,
            option_type: n.option_type,
            strike_price: n.strike_price,
            expiry: n.expiry
          }))
        }
      });
    }

    // place order with picked token
    const orderPayload = {
      instrument_token: picked.instrument_token,
      quantity,
      product,
      validity,
      price: 0,
      order_type,
      transaction_type,
      is_amo,
      tag
    };

    const resp = await adapter.placeOrder(accessToken, orderPayload);

    return res.json({
      ok: true,
      picked: {
        instrument_token: picked.instrument_token,
        tradingsymbol: picked.tradingsymbol,
        option_type: picked.option_type,
        strike_price: picked.strike_price,
        expiry: picked.expiry
      },
      orderPayload,
      upstox: resp
    });
  } catch (err: any) {
    log.error("place-option error", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || err });
  }
});


export default router;
