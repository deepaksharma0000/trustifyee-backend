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
    console.log("✅ Nifty routes loaded");
    const niftyLtp = Number(req.query.ltp);
    if (!niftyLtp) {
        return res.status(400).json({ error: "nifty ltp required" });
    }
    const chain = await (0, NiftyOptionService_1.getNiftyOptionChain)(niftyLtp);
    return res.json({ ok: true, data: chain });
});
exports.default = router;
