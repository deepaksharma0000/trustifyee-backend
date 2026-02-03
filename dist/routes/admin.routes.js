"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const AdminController_1 = require("../controllers/AdminController");
const auth_middleware_1 = require("../middleware/auth.middleware");
const upload_middleware_1 = require("../middleware/upload.middleware");
const router = express_1.default.Router();
router.get('/admin/get-admin/:id', auth_middleware_1.auth, AdminController_1.getAdminById);
router.get('/admin/all', auth_middleware_1.auth, AdminController_1.getAllAdmins);
router.put('/admin/update-register/:id', auth_middleware_1.auth, upload_middleware_1.upload.single('profile_img'), AdminController_1.updateAdmin);
router.put('/admin/update-admin/:id', auth_middleware_1.auth, upload_middleware_1.upload.single('profile_img'), AdminController_1.updateAdmin);
exports.default = router;
