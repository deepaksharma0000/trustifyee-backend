"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const aliceInstrumentService_1 = require("../services/aliceInstrumentService");
const router = express_1.default.Router();
/**
 * POST /api/alice/instruments/sync
 * body:
 * {
 *   "clientcode": "LALIT_ALICE",
 *   "exchange": "NFO"       // ya "NSE"
 * }
 */
router.post("/instruments/sync", async (req, res) => {
    const { clientcode, exchange } = req.body;
    if (!clientcode || !exchange) {
        return res
            .status(400)
            .json({ error: "clientcode and exchange are required" });
    }
    try {
        const result = await aliceInstrumentService_1.AliceInstrumentService.syncExchangeInstruments({
            clientcode,
            exchange
        });
        return res.json({ ok: true, ...result });
    }
    catch (err) {
        console.error("Alice /instruments/sync error:", err);
        return res
            .status(500)
            .json({ error: err.message || "Internal server error" });
    }
});
exports.default = router;
