"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/upstoxInstrumentSyncRoutes.ts
const express_1 = require("express");
const upstoxInstrumentSyncService_1 = require("../services/upstoxInstrumentSyncService");
const router = (0, express_1.Router)();
// Manual trigger: GET /api/upstox/instruments/sync/nse-fo
router.get("/sync/nse-fo", async (req, res) => {
    try {
        await (0, upstoxInstrumentSyncService_1.syncNseFoInstruments)();
        res.json({ ok: true, message: "NSE_FO instruments synced" });
    }
    catch (err) {
        console.error("NSE_FO sync error", err);
        res.status(500).json({ ok: false, error: err.message || err });
    }
});
exports.default = router;
