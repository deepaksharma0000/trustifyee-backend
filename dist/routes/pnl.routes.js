"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const pnl_controller_1 = require("../controllers/pnl.controller");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = (0, express_1.Router)();
router.get("/live/:clientcode", auth_middleware_1.auth, pnl_controller_1.getLivePnL);
exports.default = router;
