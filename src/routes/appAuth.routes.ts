import express from 'express';
import { registerAdmin, loginAdmin, registerUser, loginUser, logoutAdmin, logoutUser } from '../controllers/AuthController';
import { auth, adminAuth } from '../middleware/auth.middleware';
import { checkPermission } from '../middleware/permission.middleware';

const router = express.Router();

// Admin Auth
router.post('/admin/register', registerAdmin);
router.post('/admin/login', loginAdmin);
router.post('/admin/logout', auth, logoutAdmin);

// User Auth
router.post('/user/register', adminAuth, checkPermission('add_client'), registerUser);
router.post('/user/login', loginUser);
router.post('/user/logout', auth, logoutUser);

export default router;
