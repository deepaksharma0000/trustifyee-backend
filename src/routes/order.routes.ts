import { Router } from "express";
import {
  savePlacedOrder,
  getOrderStatus,
  closeOrder,
  getActivePositions,
  getTradeHistory
} from "../controllers/order.controller";
import { auth, adminOnly } from "../middleware/auth.middleware";

const router = Router();

router.post("/save", auth, adminOnly, savePlacedOrder);
router.post("/close", auth, adminOnly, closeOrder);
router.get("/active-positions/:clientcode", getActivePositions);
router.get("/trade-history/:clientcode", getTradeHistory);
router.get("/status/:clientcode/:orderid", getOrderStatus);

export default router;
