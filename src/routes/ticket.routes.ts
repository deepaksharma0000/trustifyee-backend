import express from "express";
import { auth, adminOnly } from "../middleware/auth.middleware";
import {
    getTicketsAdmin,
    updateTicketStatus,
    deleteTicket
} from "../controllers/TicketController";

const router = express.Router();

router.get("/admin/list", auth, adminOnly, getTicketsAdmin);
router.put("/:id/status", auth, adminOnly, updateTicketStatus);
router.delete("/:id", auth, adminOnly, deleteTicket);

export default router;
