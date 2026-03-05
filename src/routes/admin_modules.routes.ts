import express from 'express';
import { postInquiry, getInquiries } from '../controllers/InquiryController';
import { addStrategy, getStrategies, getStrategyById } from '../controllers/StrategyController';
import { postClientSave, getClientByUserId, getAllClients, deleteClient } from '../controllers/ClientSaveController';
import { getSegments, addGroup, getAllGroups, getGroupById, deleteGroup } from '../controllers/GroupServicesController';
import { auth, adminOnly, adminAuth } from '../middleware/auth.middleware';
import { checkPermission } from '../middleware/permission.middleware';
import { getGlobalTradingStatus, updateGlobalTradingStatus, getActiveTradingUsers } from '../controllers/SystemSettingController';

const router = express.Router();

// Inquiry
router.post('/inquiry', postInquiry); // Usually public
router.get('/inquiry/all', auth, getInquiries);

// Strategies
router.post('/strategies/add', adminAuth, checkPermission('strategy_permission'), addStrategy);
router.get('/strategies/all', adminAuth, getStrategies);
router.get('/strategies/:id', adminAuth, getStrategyById);

// Client Save
router.post('/client/save', auth, postClientSave);
router.get('/client/:user_id', auth, getClientByUserId);
router.get('/client/all', auth, getAllClients);
router.delete('/client/:user_id', auth, deleteClient);

// Group Services
router.get('/group/segments', adminAuth, getSegments);
router.post('/group/add', adminAuth, checkPermission('group_service_permission'), addGroup);
router.get('/group/all', adminAuth, getAllGroups);
router.get('/group/:id', adminAuth, getGroupById);
router.delete('/group/:id', adminAuth, checkPermission('group_service_permission'), deleteGroup);

// System Settings (Global Trading Status) - [NEW]
router.get('/system/trading-status', adminAuth, getGlobalTradingStatus);
router.post('/system/trading-status', adminAuth, adminOnly, updateGlobalTradingStatus); // Master Admin Only
router.get('/user/active-trading', adminAuth, getActiveTradingUsers);

export default router;
