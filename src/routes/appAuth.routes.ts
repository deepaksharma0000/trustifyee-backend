import express from 'express';
import { registerAdmin, loginAdmin, registerUser, loginUser, logoutAdmin, logoutUser, refreshAdminToken, refreshUserToken } from '../controllers/AuthController';
import { auth, adminAuth } from '../middleware/auth.middleware';
import { checkPermission } from '../middleware/permission.middleware';

const router = express.Router();

// Admin Auth
router.post('/admin/register', registerAdmin);
router.post('/admin/login', loginAdmin);
router.post('/admin/logout', auth, logoutAdmin);
router.post('/admin/refresh', refreshAdminToken);

// User Auth
router.post('/user/register', adminAuth, checkPermission('add_client'), registerUser);
router.post('/user/login', loginUser);
router.post('/user/logout', auth, logoutUser);
router.post('/user/refresh', refreshUserToken);

export default router;
