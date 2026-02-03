import express from 'express';
import { postInquiry, getInquiries } from '../controllers/InquiryController';
import { addStrategy, getStrategies, getStrategyById } from '../controllers/StrategyController';
import { postClientSave, getClientByUserId, getAllClients, deleteClient } from '../controllers/ClientSaveController';
import { getSegments, addGroup, getAllGroups, getGroupById } from '../controllers/GroupServicesController';
import { auth } from '../middleware/auth.middleware';

const router = express.Router();

// Inquiry
router.post('/inquiry', postInquiry); // Usually public
router.get('/inquiry/all', auth, getInquiries);

// Strategies
router.post('/strategies/add', auth, addStrategy);
router.get('/strategies/all', auth, getStrategies);
router.get('/strategies/:id', auth, getStrategyById);

// Client Save
router.post('/client/save', auth, postClientSave);
router.get('/client/:user_id', auth, getClientByUserId);
router.get('/client/all', auth, getAllClients);
router.delete('/client/:user_id', auth, deleteClient);

// Group Services
router.get('/group/segments', auth, getSegments);
router.post('/group/add', auth, addGroup);
router.get('/group/all', auth, getAllGroups);
router.get('/group/:id', auth, getGroupById);

export default router;
