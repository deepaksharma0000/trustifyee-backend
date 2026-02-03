import { Router } from "express";
import {
  savePlacedOrder,
  getOrderStatus,
  closeOrder,
  getActivePositions,
  getTradeHistory
} from "../controllers/order.controller";

const router = Router();

router.post("/save", savePlacedOrder);
router.post("/close", closeOrder);
router.get("/active-positions/:clientcode", getActivePositions);
router.get("/trade-history/:clientcode", getTradeHistory);
router.get("/status/:clientcode/:orderid", getOrderStatus);

export default router;
