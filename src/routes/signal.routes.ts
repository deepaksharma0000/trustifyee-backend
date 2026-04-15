import express from 'express';
import { getAllSignals, getActiveSignals } from '../controllers/SignalController';
import { executeSignal, broadcastSignal, recordExecutionResult } from '../controllers/SignalComplianceController';
import { auth, adminAuth } from '../middleware/auth.middleware';
import { SignalService } from '../services/SignalService';

const router = express.Router();

router.get('/all', adminAuth, getAllSignals);
router.get('/active', auth, getActiveSignals);
router.post('/execute', auth, executeSignal);
router.post('/broadcast', auth, adminAuth, broadcastSignal);
router.post('/execution-events', auth, recordExecutionResult);

// FIX #9: HTTP Fallback for signal polling (when WebSocket is disconnected)
router.get('/pending', auth, async (req: any, res) => {
    try {
        const userId = req.id;
        const signals = await SignalService.getActiveSignalsForUser(userId);
        return res.json({ ok: true, count: signals.length, signals });
    } catch (err: any) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

export default router;

