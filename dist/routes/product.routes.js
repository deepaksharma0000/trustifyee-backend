"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const ProductController_1 = require("../controllers/ProductController");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = (0, express_1.Router)();
router.get('/list', auth_middleware_1.auth, ProductController_1.getProductList);
router.get('/details', auth_middleware_1.auth, ProductController_1.getProductDetails);
exports.default = router;
