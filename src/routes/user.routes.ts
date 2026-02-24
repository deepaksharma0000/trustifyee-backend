import express from 'express';
import {
    updateUser, updateUserBroker, deleteUser, getLoggedInUsers, getStarUsers,
    getUserTotalCount, getUsersByEndDate, getUserSearch, verifyUserBroker,
    toggleStarClient
} from '../controllers/UserController';
import { adminAuth, userAuth } from '../middleware/auth.middleware';

const router = express.Router();

router.put('/user/update-register/:id', adminAuth, updateUser);
router.put('/user/update-broker/:id', userAuth, updateUserBroker); // [NEW] Split API
router.delete('/user/delete-client/:id', adminAuth, deleteUser);
router.get('/user/logged-in', adminAuth, getLoggedInUsers);
router.get('/user/star-clients', adminAuth, getStarUsers);
router.get('/user/total-count', adminAuth, getUserTotalCount);
router.get('/user/by-enddate', adminAuth, getUsersByEndDate);
router.get('/user/user-search', adminAuth, getUserSearch);
router.post('/user/verify-broker/:id', adminAuth, verifyUserBroker);
router.post('/user/toggle-star-client/:id', adminAuth, toggleStarClient);

export default router;
