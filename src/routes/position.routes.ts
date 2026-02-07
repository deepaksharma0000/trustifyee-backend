import { Router } from "express";
import {
  getOpenPositions,
  closePosition,
} from "../controllers/position.controller";
import { auth, adminOnly } from "../middleware/auth.middleware";

const router = Router();

router.get("/open/:clientcode", getOpenPositions);
router.post("/close", auth, adminOnly, closePosition);

export default router;
