import express from 'express';
import { getAdminById, getAllAdmins, updateAdmin } from '../controllers/AdminController';
import { adminAuth } from '../middleware/auth.middleware';
import { upload } from '../middleware/upload.middleware';

const router = express.Router();

router.get('/admin/get-admin/:id', adminAuth, getAdminById);
router.get('/admin/get-admin', adminAuth, getAllAdmins); // Normal list view
router.get('/admin/get-admin/', adminAuth, getAllAdmins); // Fallback for trailing slash
router.get('/admin/all', adminAuth, getAllAdmins);
router.put('/admin/update-register/:id', adminAuth, upload.single('profile_img'), updateAdmin);
router.put('/admin/update-admin/:id', adminAuth, upload.single('profile_img'), updateAdmin);

export default router;
