"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const order_controller_1 = require("../controllers/order.controller");
const router = (0, express_1.Router)();
router.post("/save", order_controller_1.savePlacedOrder);
router.get("/status/:clientcode/:orderid", order_controller_1.getOrderStatus);
exports.default = router;
