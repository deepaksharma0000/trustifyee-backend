"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/nifty.ts
const express_1 = __importDefault(require("express"));
const NiftyOptionService_1 = require("../services/NiftyOptionService");
const router = express_1.default.Router();
router.get("/option-chain", async (req, res) => {
    const ltp = req.query.ltp ? Number(req.query.ltp) : undefined;
    const symbol = req.query.symbol || "NIFTY";
    const chain = await (0, NiftyOptionService_1.getOptionChain)(symbol, ltp);
    return res.json({ ok: true, data: chain });
});
exports.default = router;
