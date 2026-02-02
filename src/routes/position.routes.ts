import { Router } from "express";
import {
  getOpenPositions,
  closePosition,
} from "../controllers/position.controller";

const router = Router();

router.get("/open/:clientcode", getOpenPositions);
router.post("/close", closePosition);

export default router;
