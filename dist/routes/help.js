"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const HelpController_1 = require("../controllers/HelpController");
const router = (0, express_1.Router)();
router.post('/submit', HelpController_1.HelpController.submitRequest);
exports.default = router;
