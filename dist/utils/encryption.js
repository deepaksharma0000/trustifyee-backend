"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.maskKey = exports.decrypt = exports.encrypt = void 0;
const crypto_1 = __importDefault(require("crypto"));
const config_1 = require("../config");
const ENCRYPTION_KEY = config_1.config.encryptionKey || 'your-default-secure-key-32-chars-long'; // Fallback for dev only
const IV_LENGTH = 16; // AES block size
// Ensure key is 32 bytes (256 bits)
const getKey = () => {
    return crypto_1.default.createHash('sha256').update(String(ENCRYPTION_KEY)).digest();
};
const encrypt = (text) => {
    if (!text)
        return text;
    try {
        const iv = crypto_1.default.randomBytes(IV_LENGTH);
        const cipher = crypto_1.default.createCipheriv('aes-256-cbc', getKey(), iv);
        let encrypted = cipher.update(text);
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        return iv.toString('hex') + ':' + encrypted.toString('hex');
    }
    catch (error) {
        console.error('Encryption failed:', error);
        return text; // Fail safe or throw? Ideally throw in production.
    }
};
exports.encrypt = encrypt;
const decrypt = (text) => {
    if (!text)
        return text;
    const textParts = text.split(':');
    if (textParts.length < 2)
        return text; // Not encrypted or legacy format
    try {
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto_1.default.createDecipheriv('aes-256-cbc', getKey(), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    }
    catch (error) {
        console.error('Decryption failed:', error);
        return text;
    }
};
exports.decrypt = decrypt;
const maskKey = (key) => {
    if (!key || key.trim() === "")
        return "";
    if (key.length < 8)
        return "********";
    return '****' + key.slice(-4);
};
exports.maskKey = maskKey;
