"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const position_controller_1 = require("../controllers/position.controller");
const router = (0, express_1.Router)();
router.get("/open/:clientcode", position_controller_1.getOpenPositions);
router.post("/close", position_controller_1.closePosition);
exports.default = router;
