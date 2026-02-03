import { Router } from "express";
import { handleWebhookSignal } from "../controllers/webhook.controller";

const router = Router();

router.post("/signal", handleWebhookSignal);

export default router;
