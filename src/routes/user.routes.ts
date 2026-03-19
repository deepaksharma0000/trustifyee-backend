import express from 'express';
import {
    updateUser, updateUserBroker, deleteUser, getLoggedInUsers, getStarUsers,
    getUserTotalCount, getUsersByEndDate, getUserSearch, verifyUserBroker,
    toggleStarClient, getBrokerSessionStatus, updateLotMultipliers
} from '../controllers/UserController';
import { adminAuth, userAuth } from '../middleware/auth.middleware';
import { checkPermission } from '../middleware/permission.middleware';

const router = express.Router();

router.put('/user/update-register/:id', adminAuth, checkPermission('edit_client'), updateUser);
router.put('/user/update-broker/:id', userAuth, updateUserBroker); // [NEW] Split API
router.put('/user/lot-multipliers/:id', userAuth, updateLotMultipliers); // [NEW] Update Personal Lot Multipliers
router.delete('/user/delete-client/:id', adminAuth, checkPermission('edit_client'), deleteUser);
router.get('/user/logged-in', adminAuth, getLoggedInUsers);
router.get('/user/star-clients', adminAuth, getStarUsers);
router.get('/user/total-count', adminAuth, getUserTotalCount);
router.get('/user/by-enddate', adminAuth, getUsersByEndDate);
router.get('/user/user-search', adminAuth, getUserSearch);
router.post('/user/verify-broker/:id', adminAuth, checkPermission('edit_client'), verifyUserBroker);
router.post('/user/toggle-star-client/:id', adminAuth, checkPermission('edit_client'), toggleStarClient);
// [NEW] Check if a specific user has an active broker session
router.get('/user/broker-session-status/:id', adminAuth, getBrokerSessionStatus);

export default router;
