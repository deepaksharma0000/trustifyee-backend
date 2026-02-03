import express from 'express';
import { registerAdmin, loginAdmin, registerUser, loginUser } from '../controllers/AuthController';

const router = express.Router();

// Admin Auth
router.post('/admin/register', registerAdmin);
router.post('/admin/login', loginAdmin);

// User Auth
router.post('/user/register', registerUser);
router.post('/user/login', loginUser);

export default router;
