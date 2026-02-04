"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const AuthController_1 = require("../controllers/AuthController");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = express_1.default.Router();
// Admin Auth
router.post('/admin/register', AuthController_1.registerAdmin);
router.post('/admin/login', AuthController_1.loginAdmin);
router.post('/admin/logout', auth_middleware_1.auth, AuthController_1.logoutAdmin);
// User Auth
router.post('/user/register', AuthController_1.registerUser);
router.post('/user/login', AuthController_1.loginUser);
router.post('/user/logout', auth_middleware_1.auth, AuthController_1.logoutUser);
exports.default = router;
