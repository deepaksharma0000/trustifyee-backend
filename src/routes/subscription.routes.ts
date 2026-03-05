import { Router } from 'express';
import {
    submitSubscriptionRequest,
    getMyRequests,
    getAllRequestsAdmin,
    processSubscriptionAdmin
} from '../controllers/subscription.controller';
import { auth, adminOnly } from '../middleware/auth.middleware';

const router = Router();

// User Routes
router.post('/submit', auth, submitSubscriptionRequest);
router.get('/my-requests', auth, getMyRequests);

// Admin Routes
router.get('/admin/all', auth, adminOnly, getAllRequestsAdmin);
router.post('/admin/process', auth, adminOnly, processSubscriptionAdmin);

export default router;
