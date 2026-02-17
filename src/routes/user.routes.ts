import express from 'express';
import {
    updateUser, updateUserBroker, deleteUser, getLoggedInUsers,
    getUserTotalCount, getUsersByEndDate, getUserSearch, verifyUserBroker
} from '../controllers/UserController';
import { auth } from '../middleware/auth.middleware';

const router = express.Router();

router.put('/user/update-register/:id', auth, updateUser);
router.put('/user/update-broker/:id', auth, updateUserBroker); // [NEW] Split API
router.delete('/user/delete-client/:id', auth, deleteUser);
router.get('/user/logged-in', auth, getLoggedInUsers);
router.get('/user/total-count', auth, getUserTotalCount);
router.get('/user/by-enddate', auth, getUsersByEndDate);
router.get('/user/user-search', auth, getUserSearch);
router.post('/user/verify-broker/:id', auth, verifyUserBroker);

export default router;
