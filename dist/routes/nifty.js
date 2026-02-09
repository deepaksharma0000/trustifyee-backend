"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const config_1 = require("../config");
const NiftyOptionService_1 = require("../services/NiftyOptionService");
const router = express_1.default.Router();
router.get("/option-chain", async (req, res) => {
    if (req.query.ltp && config_1.config.nodeEnv === "production") {
        return res.status(400).json({ ok: false, error: "LTP override not allowed in production" });
    }
    const expiry = req.query.expiry ? String(req.query.expiry) : undefined;
    const range = req.query.range ? Number(req.query.range) : 5;
    const symbol = req.query.symbol || "NIFTY";
    const chain = await (0, NiftyOptionService_1.getOptionChain)(symbol, expiry, range);
    return res.json({ ok: true, data: chain });
});
exports.default = router;
