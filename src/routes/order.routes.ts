import { Router } from "express";
import {
  savePlacedOrder,
  getOrderStatus,
} from "../controllers/order.controller";

const router = Router();

router.post("/save", savePlacedOrder);
router.get("/status/:clientcode/:orderid", getOrderStatus);

export default router;
