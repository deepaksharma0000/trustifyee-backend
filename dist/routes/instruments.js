"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const InstrumentService_1 = require("../services/InstrumentService");
const logger_1 = require("../utils/logger");
const router = express_1.default.Router();
router.post("/sync", async (_req, res) => {
    try {
        await (0, InstrumentService_1.syncNiftyOptionsOnly)();
        return res.json({ ok: true });
    }
    catch (err) {
        logger_1.log.error("instrument sync error", err.message || err);
        return res.status(500).json({ ok: false, error: err.message || err });
    }
});
router.get("/lookup", async (req, res) => {
    const exchange = req.query.exchange || "";
    const tradingsymbol = req.query.tradingsymbol || "";
    if (!exchange || !tradingsymbol) {
        return res.status(400).json({ ok: false, error: "exchange & tradingsymbol required" });
    }
    try {
        const symbol = await (0, InstrumentService_1.findSymbol)(exchange, tradingsymbol);
        if (!symbol) {
            return res.status(404).json({ ok: false, error: "symboltoken not found" });
        }
        return res.json({
            ok: true,
            data: {
                tradingsymbol: symbol.tradingsymbol,
                symboltoken: symbol.symboltoken,
                exchange: symbol.exchange,
                instrumenttype: symbol.instrumenttype,
                name: symbol.name
            }
        });
    }
    catch (e) {
        return res.status(500).json({ ok: false, error: e.message || e });
    }
});
exports.default = router;
