"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const auth_middleware_1 = require("../middleware/auth.middleware");
const MessageController_1 = require("../controllers/MessageController");
const router = express_1.default.Router();
// Admin routes
router.post("/dispatch", auth_middleware_1.auth, auth_middleware_1.adminOnly, MessageController_1.createMessage);
router.get("/admin/list", auth_middleware_1.auth, auth_middleware_1.adminOnly, MessageController_1.getMessagesAdmin);
router.delete("/:id", auth_middleware_1.auth, auth_middleware_1.adminOnly, MessageController_1.deleteMessage);
router.put("/:id", auth_middleware_1.auth, auth_middleware_1.adminOnly, MessageController_1.updateMessage);
// User routes
router.get("/user/list", auth_middleware_1.auth, MessageController_1.getMessagesUser);
exports.default = router;
