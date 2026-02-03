import express from 'express';
import {
    updateUser, deleteUser, getLoggedInUsers,
    getUserTotalCount, getUsersByEndDate, getUserSearch
} from '../controllers/UserController';
import { auth } from '../middleware/auth.middleware';

const router = express.Router();

router.put('/user/update-register/:id', auth, updateUser);
router.delete('/user/delete-client/:id', auth, deleteUser);
router.get('/user/logged-in', auth, getLoggedInUsers);
router.get('/user/total-count', auth, getUserTotalCount);
router.get('/user/by-enddate', auth, getUsersByEndDate);
router.get('/user/user-search', auth, getUserSearch);

export default router;
