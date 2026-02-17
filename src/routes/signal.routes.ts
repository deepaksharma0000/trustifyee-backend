import express from 'express';
import { executeSignal, getActiveSignals } from '../controllers/SignalController';
import { auth } from '../middleware/auth.middleware';

const router = express.Router();

router.get('/active', auth, getActiveSignals);
router.post('/execute', auth, executeSignal);

export default router;
