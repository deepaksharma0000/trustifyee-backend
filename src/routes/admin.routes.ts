import express from 'express';
import { getAdminById, getAllAdmins, updateAdmin } from '../controllers/AdminController';
import { auth } from '../middleware/auth.middleware';
import { upload } from '../middleware/upload.middleware';

const router = express.Router();

router.get('/admin/get-admin/:id', auth, getAdminById);
router.get('/admin/all', auth, getAllAdmins);
router.put('/admin/update-register/:id', auth, upload.single('profile_img'), updateAdmin);
router.put('/admin/update-admin/:id', auth, upload.single('profile_img'), updateAdmin);

export default router;
