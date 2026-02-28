"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const auth_middleware_1 = require("../middleware/auth.middleware");
const TicketController_1 = require("../controllers/TicketController");
const router = express_1.default.Router();
router.get("/admin/list", auth_middleware_1.auth, auth_middleware_1.adminOnly, TicketController_1.getTicketsAdmin);
router.put("/:id/status", auth_middleware_1.auth, auth_middleware_1.adminOnly, TicketController_1.updateTicketStatus);
router.delete("/:id", auth_middleware_1.auth, auth_middleware_1.adminOnly, TicketController_1.deleteTicket);
exports.default = router;
