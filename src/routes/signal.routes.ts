import express from 'express';
import { executeSignal, getAllSignals } from '../controllers/SignalController';
import { auth, adminAuth } from '../middleware/auth.middleware';

const router = express.Router();

router.get('/all', adminAuth, getAllSignals);
router.post('/execute', auth, executeSignal);

export default router;
