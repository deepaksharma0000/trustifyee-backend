import express from "express";
import { auth, adminOnly } from "../middleware/auth.middleware";
import {
    createMessage,
    getMessagesAdmin,
    deleteMessage,
    updateMessage,
    getMessagesUser
} from "../controllers/MessageController";

const router = express.Router();

// Admin routes
router.post("/dispatch", auth, adminOnly, createMessage);
router.get("/admin/list", auth, adminOnly, getMessagesAdmin);
router.delete("/:id", auth, adminOnly, deleteMessage);
router.put("/:id", auth, adminOnly, updateMessage);

// User routes
router.get("/user/list", auth, getMessagesUser);

export default router;
