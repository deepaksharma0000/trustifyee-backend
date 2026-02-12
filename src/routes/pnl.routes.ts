import { Router } from "express";
import { getLivePnL } from "../controllers/pnl.controller";
import { auth } from "../middleware/auth.middleware";

const router = Router();

router.get("/live/:clientcode", auth, getLivePnL);

export default router;
