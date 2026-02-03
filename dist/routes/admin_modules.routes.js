"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const InquiryController_1 = require("../controllers/InquiryController");
const StrategyController_1 = require("../controllers/StrategyController");
const ClientSaveController_1 = require("../controllers/ClientSaveController");
const GroupServicesController_1 = require("../controllers/GroupServicesController");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = express_1.default.Router();
// Inquiry
router.post('/inquiry', InquiryController_1.postInquiry); // Usually public
router.get('/inquiry/all', auth_middleware_1.auth, InquiryController_1.getInquiries);
// Strategies
router.post('/strategies/add', auth_middleware_1.auth, StrategyController_1.addStrategy);
router.get('/strategies/all', auth_middleware_1.auth, StrategyController_1.getStrategies);
router.get('/strategies/:id', auth_middleware_1.auth, StrategyController_1.getStrategyById);
// Client Save
router.post('/client/save', auth_middleware_1.auth, ClientSaveController_1.postClientSave);
router.get('/client/:user_id', auth_middleware_1.auth, ClientSaveController_1.getClientByUserId);
router.get('/client/all', auth_middleware_1.auth, ClientSaveController_1.getAllClients);
router.delete('/client/:user_id', auth_middleware_1.auth, ClientSaveController_1.deleteClient);
// Group Services
router.get('/group/segments', auth_middleware_1.auth, GroupServicesController_1.getSegments);
router.post('/group/add', auth_middleware_1.auth, GroupServicesController_1.addGroup);
router.get('/group/all', auth_middleware_1.auth, GroupServicesController_1.getAllGroups);
router.get('/group/:id', auth_middleware_1.auth, GroupServicesController_1.getGroupById);
exports.default = router;
