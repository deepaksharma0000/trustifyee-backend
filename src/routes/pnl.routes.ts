import { Router } from "express";
import { getLivePnL } from "../controllers/pnl.controller";

const router = Router();

router.get("/live/:clientcode", getLivePnL);

export default router;
