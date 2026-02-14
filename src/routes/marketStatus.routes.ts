import { Router } from "express";
import { MarketStatusService } from "../services/MarketStatusService";

const router = Router();

router.get("/status", (req, res) => {
    const status = MarketStatusService.getMarketStatus();
    res.json({
        ok: true,
        data: status
    });
});

export default router;
