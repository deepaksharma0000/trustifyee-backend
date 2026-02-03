"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TimeDiffrance = exports.generateAccessCode = exports.validatePhoneNumber = exports.validateEmail = void 0;
const moment_1 = __importDefault(require("moment"));
const validateEmail = (email) => {
    const re = /\S+@\S+\.\S+/;
    return re.test(email);
};
exports.validateEmail = validateEmail;
const validatePhoneNumber = (phone) => {
    // Basic validation, enhance as needed
    const re = /^[0-9]{10,15}$/;
    return re.test(phone);
};
exports.validatePhoneNumber = validatePhoneNumber;
const generateAccessCode = async () => {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = (0, moment_1.default)().add(10, 'minutes').toDate();
    return { otp, expiry };
};
exports.generateAccessCode = generateAccessCode;
const TimeDiffrance = (expiresAt, currentTime, unit = 'm') => {
    const end = (0, moment_1.default)(expiresAt);
    const now = (0, moment_1.default)(currentTime);
    return end.diff(now, unit === 'm' ? 'minutes' : 'seconds'); // if negative, expired
};
exports.TimeDiffrance = TimeDiffrance;
