import express from 'express';
import {
    updateUser, updateUserBroker, deleteUser, getLoggedInUsers, getStarUsers,
    getUserTotalCount, getUsersByEndDate, getUserSearch, verifyUserBroker,
    toggleStarClient, getBrokerSessionStatus, updateLotMultipliers, getRiskStatus,
    reactivateTrading
} from '../controllers/UserController';
import { adminAuth, userAuth, commonAuth } from '../middleware/auth.middleware';
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
// [NEW] Get pre-trade risk status
router.get('/user/risk-status/:id', commonAuth, getRiskStatus);
router.post('/user/reactivate-trading/:id', commonAuth, reactivateTrading);

export default router;
