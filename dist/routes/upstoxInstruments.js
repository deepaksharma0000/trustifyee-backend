"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/upstoxInstruments.ts
const express_1 = __importDefault(require("express"));
const UpstoxAdapter_1 = require("../adapters/UpstoxAdapter");
const UpstoxTokens_1 = __importDefault(require("../models/UpstoxTokens"));
const UpstoxInstrument_1 = __importDefault(require("../models/UpstoxInstrument"));
const logger_1 = require("../utils/logger");
const router = express_1.default.Router();
const adapter = new UpstoxAdapter_1.UpstoxAdapter();
/**
 * Helper - get access token for user
 */
async function getAccessToken(userId) {
    const doc = await UpstoxTokens_1.default.findOne({ userId }).exec();
    if (!doc || !doc.accessToken) {
        throw new Error("No active Upstox session for userId");
    }
    return doc.accessToken;
}
/**
 * Helper: safe upsert by instrument_key with retry on duplicate-key race
 */
async function safeUpsertByInstrumentKey(key, mapped) {
    if (!key)
        throw new Error("instrument_key is required for safeUpsert");
    try {
        // atomic upsert by unique key
        await UpstoxInstrument_1.default.updateOne({ instrument_key: key }, { $set: mapped }, { upsert: true });
        // return the saved doc
        return UpstoxInstrument_1.default.findOne({ instrument_key: key }).lean().exec();
    }
    catch (err) {
        // E11000 duplicate key race -> retry as an update (no upsert)
        if (err && (err.code === 11000 || (err.message && err.message.includes("E11000")))) {
            return UpstoxInstrument_1.default.findOneAndUpdate({ instrument_key: key }, { $set: mapped }, { upsert: false, new: true }).lean().exec();
        }
        throw err;
    }
}
/**
 * Fetch from Upstox & optionally save into DB.
 * POST /api/upstox/instruments/sync-option
 * Body: { userId: "...", instrument_key: "NSE_INDEX|Nifty 50", save: true }
 */
router.post("/sync-option", async (req, res) => {
    try {
        const { userId, instrument_key, save = true } = req.body;
        if (!userId)
            return res.status(400).json({ ok: false, error: "userId is required" });
        if (!instrument_key)
            return res.status(400).json({ ok: false, error: "instrument_key is required" });
        const accessToken = await getAccessToken(userId);
        // fetch from Upstox
        const rawResp = await adapter.fetchOptionContract(accessToken, instrument_key);
        const data = rawResp?.data?.data || rawResp?.data || rawResp;
        if (!data) {
            return res.status(500).json({ ok: false, error: "Empty response from Upstox" });
        }
        // Helper: normalize one item into our DB shape
        const mapItem = (item) => {
            return {
                instrument_key,
                instrument_token: item?.instrument_token ?? item?.token ?? item?.instrumentToken ?? item?.token_id ?? null,
                tradingsymbol: item?.tradingsymbol ?? item?.trading_symbol ?? item?.symbol ?? item?.name ?? null,
                name: item?.name ?? item?.description ?? null,
                exchange: item?.exchange ?? item?.exchange_type ?? null,
                segment: item?.segment ?? null,
                option_type: item?.option_type ?? item?.opt_type ?? item?.type ?? null,
                strike_price: item?.strike_price ?? item?.strike ?? item?.strikePrice ?? null,
                expiry: item?.expiry ? new Date(item.expiry) : (item?.expiry_date ? new Date(item.expiry_date) : null),
                lot_size: item?.lot_size ?? item?.board_lot_size ?? item?.lotSize ?? null,
                tick_size: item?.tick_size ?? item?.tickSize ?? null,
                raw: item
            };
        };
        let saved = null;
        // If data is an array of instruments -> bulk upsert
        // if (Array.isArray(data)) {
        //   if (save) {
        //     const ops = data.map((it: any) => {
        //       const mapped = mapItem(it);
        //       const key = mapped.instrument_key || instrument_key || mapped.tradingsymbol || mapped.instrument_token;
        //       // ensure filter uses instrument_key when available
        //       // const filter = mapped.instrument_key
        //       //   ? { instrument_key: mapped.instrument_key }
        //       //   : (mapped.instrument_token ? { instrument_token: mapped.instrument_token } : { tradingsymbol: mapped.tradingsymbol });
        //       const filter = { instrument_token: mapped.instrument_token };
        //     log.info("Prepared ops count:", ops.length);
        //       return {
        //         updateOne: {
        //           filter,
        //           update: { $set: mapped },
        //           upsert: true
        //         }
        //       };
        //     });
        //     if (ops.length > 0) {
        //       // ordered:false prevents one failure from stopping other ops
        //       const bulkResult = await UpstoxInstrumentModel.bulkWrite(ops, { ordered: false });
        //       log.info("bulkWrite saved instruments", { count: ops.length, result: bulkResult });
        //     }
        //   }
        //   const mappedArray = data.map(mapItem);
        //   return res.json({ ok: true, source: "upstox", count: mappedArray.length, data: mappedArray });
        // }
        if (Array.isArray(data)) {
            if (save) {
                const ops = data.map((it) => {
                    const mapped = mapItem(it);
                    // real unique identifiers from Upstox
                    const filter = mapped.instrument_token
                        ? { instrument_token: mapped.instrument_token }
                        : { tradingsymbol: mapped.tradingsymbol };
                    return {
                        updateOne: {
                            filter,
                            update: { $set: mapped },
                            upsert: true,
                        },
                    };
                });
                if (ops.length > 0) {
                    const bulkResult = await UpstoxInstrument_1.default.bulkWrite(ops, {
                        ordered: false,
                    });
                    logger_1.log.info("bulkWrite saved instruments", {
                        count: ops.length,
                        result: bulkResult,
                    });
                }
            }
            const mappedArray = data.map(mapItem);
            return res.json({
                ok: true,
                source: "upstox",
                count: mappedArray.length,
                data: mappedArray,
            });
        }
        // If data is a single object
        const mapped = mapItem(data);
        if (save) {
            // Prefer instrument_key as canonical upsert key
            const key = mapped.instrument_key || instrument_key;
            saved = await safeUpsertByInstrumentKey(key, mapped);
        }
        return res.json({ ok: true, source: "upstox", mapped, saved });
    }
    catch (err) {
        logger_1.log.error("sync-option error", err?.message || err);
        return res.status(500).json({ ok: false, error: err?.message || err });
    }
});
/**
 * GET /api/upstox/instruments/list
 * Query params: q, exchange, segment, limit, skip
 * Returns instruments from DB (filtered). Good for quick filtering.
 */
router.get("/list", async (req, res) => {
    try {
        const { q, exchange, segment, limit = "50", skip = "0" } = req.query;
        const filter = {};
        if (q) {
            filter.$or = [
                { tradingsymbol: new RegExp(q, "i") },
                { name: new RegExp(q, "i") },
                { instrument_token: new RegExp(q, "i") }
            ];
        }
        if (exchange)
            filter.exchange = exchange;
        if (segment)
            filter.segment = segment;
        const docs = await UpstoxInstrument_1.default.find(filter)
            .limit(Number(limit))
            .skip(Number(skip))
            .lean()
            .exec();
        return res.json({ ok: true, data: docs });
    }
    catch (err) {
        logger_1.log.error("List instruments error", err);
        return res.status(500).json({ ok: false, error: err.message || err });
    }
});
/**
 * GET /api/upstox/instruments/fetch-from-upstox
 * Fetch using Upstox search endpoint and optionally save into DB.
 * Query: userId, q, save=true
 *
 * NOTE: placed before the param route so "/fetch-from-upstox" is matched correctly.
 */
router.get("/fetch-from-upstox", async (req, res) => {
    try {
        const { userId, q, save } = req.query;
        if (!userId)
            return res.status(400).json({ ok: false, error: "userId query param required" });
        const accessToken = await getAccessToken(userId);
        const params = {};
        if (q)
            params.q = q;
        const resp = await adapter.searchInstruments(accessToken, params);
        const instruments = Array.isArray(resp) ? resp : resp?.data ?? resp?.instruments ?? [];
        if ((save === "true" || save === true) && Array.isArray(instruments) && instruments.length > 0) {
            const ops = instruments.map((ins) => {
                const mapped = {
                    instrument_key: ins.instrument_key ?? `${ins.exchange ?? ""}|${ins.tradingsymbol ?? ins.symbol ?? ""}`,
                    instrument_token: ins.instrument_token,
                    tradingsymbol: ins.tradingsymbol || ins.trading_symbol || ins.symbol,
                    name: ins.name || ins.description,
                    exchange: ins.exchange,
                    segment: ins.segment,
                    instrument_type: ins.instrument_type,
                    expiry: ins.expiry ? new Date(ins.expiry) : null,
                    strike_price: ins.strike_price ?? null,
                    lot_size: ins.lot_size ?? null,
                    tick_size: ins.tick_size ?? null,
                    raw: ins
                };
                const filter = mapped.instrument_key ? { instrument_key: mapped.instrument_key } : { instrument_token: mapped.instrument_token };
                return {
                    updateOne: {
                        filter,
                        update: { $set: mapped },
                        upsert: true
                    }
                };
            });
            if (ops.length > 0) {
                await UpstoxInstrument_1.default.bulkWrite(ops, { ordered: false });
            }
        }
        return res.json({ ok: true, count: instruments.length, data: instruments });
    }
    catch (err) {
        logger_1.log.error("Fetch from Upstox error", err);
        return res.status(500).json({ ok: false, error: err.message || err });
    }
});
/**
 * GET /api/upstox/instruments/:instrumentToken
 * Try DB, if not found, fetch from Upstox (requires userId query param to obtain token)
 * Query: ?userId=xxxxx
 */
router.get("/:instrumentToken", async (req, res) => {
    try {
        const instrumentToken = req.params.instrumentToken;
        const { userId } = req.query;
        if (!instrumentToken)
            return res.status(400).json({ ok: false, error: "instrumentToken required" });
        // Try DB first
        const doc = await UpstoxInstrument_1.default.findOne({ instrument_token: instrumentToken }).lean().exec();
        if (doc) {
            return res.json({ ok: true, source: "db", data: doc });
        }
        // If not in DB, fetch from Upstox if userId provided
        if (!userId) {
            return res.status(404).json({ ok: false, error: "Not found in DB. Provide userId to fetch from Upstox." });
        }
        const accessToken = await getAccessToken(userId);
        // Adapter call - adjust endpoint name if your Upstox API differs
        const resp = await adapter.getInstrumentInfo(accessToken, instrumentToken);
        const payload = {
            instrument_token: instrumentToken,
            tradingsymbol: resp.tradingsymbol || resp.trading_symbol || resp.symbol,
            name: resp.name || resp.description || resp.tradingsymbol,
            exchange: resp.exchange || resp.exchange_type,
            segment: resp.segment,
            instrument_type: resp.instrument_type || resp.type,
            expiry: resp.expiry ? new Date(resp.expiry) : null,
            strike_price: resp.strike_price ?? null,
            lot_size: resp.lot_size ?? null,
            tick_size: resp.tick_size ?? null,
            raw: resp
        };
        // upsert by instrument_token (token should be unique)
        await UpstoxInstrument_1.default.updateOne({ instrument_token: instrumentToken }, { $set: payload }, { upsert: true });
        return res.json({ ok: true, source: "upstox", data: payload });
    }
    catch (err) {
        logger_1.log.error("Get instrument error", err);
        return res.status(500).json({ ok: false, error: err.message || err });
    }
});
exports.default = router;
