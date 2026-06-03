import express from 'express';
import { getAllSignals, getActiveSignals, queueExecution, getExecutionStatus, getExecutionSummary, broadcastSignal } from '../controllers/SignalController';
import { executeSignal, recordExecutionResult } from '../controllers/SignalComplianceController';
import { auth, adminAuth, userAuth } from '../middleware/auth.middleware';
import { SignalService } from '../services/SignalService';

const router = express.Router();

router.get('/all', adminAuth, getAllSignals);
router.get('/active', auth, getActiveSignals);
router.get('/execution-status/:signalId', auth, getExecutionStatus);
router.get('/execution-summary/:signalId', adminAuth, getExecutionSummary);
router.post('/execute', auth, executeSignal);
router.post('/queue-execution', userAuth, queueExecution);

router.post('/broadcast', auth, adminAuth, broadcastSignal);
router.post('/execution-events', auth, recordExecutionResult);

router.get('/pending', userAuth, async (req: any, res) => {
    try {
        const userId = req.id;
        const signals = await SignalService.getActiveSignalsForUser(userId);
        return res.json({ ok: true, count: signals.length, signals });
    } catch (err: any) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

export default router;
