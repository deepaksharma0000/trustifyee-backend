"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const pnl_controller_1 = require("../controllers/pnl.controller");
const router = (0, express_1.Router)();
router.get("/live/:clientcode", pnl_controller_1.getLivePnL);
exports.default = router;
