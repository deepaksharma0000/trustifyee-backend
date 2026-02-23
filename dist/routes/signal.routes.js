"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const SignalController_1 = require("../controllers/SignalController");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = express_1.default.Router();
router.get('/active', auth_middleware_1.auth, SignalController_1.getActiveSignals);
router.post('/execute', auth_middleware_1.auth, SignalController_1.executeSignal);
exports.default = router;
