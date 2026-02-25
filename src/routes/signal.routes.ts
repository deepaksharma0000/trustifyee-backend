import express from 'express';
import { executeSignal, getAllSignals, broadcastSignal } from '../controllers/SignalController';
import { auth, adminAuth } from '../middleware/auth.middleware';

const router = express.Router();

router.get('/all', adminAuth, getAllSignals);
router.post('/execute', auth, executeSignal);
router.post('/broadcast', auth, adminAuth, broadcastSignal);

export default router;
