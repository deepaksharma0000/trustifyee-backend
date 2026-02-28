"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const UserController_1 = require("../controllers/UserController");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = express_1.default.Router();
router.put('/user/update-register/:id', auth_middleware_1.adminAuth, UserController_1.updateUser);
router.put('/user/update-broker/:id', auth_middleware_1.userAuth, UserController_1.updateUserBroker); // [NEW] Split API
router.delete('/user/delete-client/:id', auth_middleware_1.adminAuth, UserController_1.deleteUser);
router.get('/user/logged-in', auth_middleware_1.adminAuth, UserController_1.getLoggedInUsers);
router.get('/user/star-clients', auth_middleware_1.adminAuth, UserController_1.getStarUsers);
router.get('/user/total-count', auth_middleware_1.adminAuth, UserController_1.getUserTotalCount);
router.get('/user/by-enddate', auth_middleware_1.adminAuth, UserController_1.getUsersByEndDate);
router.get('/user/user-search', auth_middleware_1.adminAuth, UserController_1.getUserSearch);
router.post('/user/verify-broker/:id', auth_middleware_1.adminAuth, UserController_1.verifyUserBroker);
router.post('/user/toggle-star-client/:id', auth_middleware_1.adminAuth, UserController_1.toggleStarClient);
exports.default = router;
