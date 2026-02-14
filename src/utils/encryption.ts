import crypto from 'crypto';
import { config } from '../config';

const ENCRYPTION_KEY = config.encryptionKey || 'your-default-secure-key-32-chars-long'; // Fallback for dev only
const IV_LENGTH = 16; // AES block size

// Ensure key is 32 bytes (256 bits)
const getKey = () => {
    return crypto.createHash('sha256').update(String(ENCRYPTION_KEY)).digest();
};

export const encrypt = (text: string): string => {
    if (!text) return text;
    try {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv('aes-256-cbc', getKey(), iv);
        let encrypted = cipher.update(text);
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        return iv.toString('hex') + ':' + encrypted.toString('hex');
    } catch (error) {
        console.error('Encryption failed:', error);
        return text; // Fail safe or throw? Ideally throw in production.
    }
};

export const decrypt = (text: string): string => {
    if (!text) return text;
    const textParts = text.split(':');
    if (textParts.length < 2) return text; // Not encrypted or legacy format

    try {
        const iv = Buffer.from(textParts.shift()!, 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', getKey(), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (error) {
        console.error('Decryption failed:', error);
        return text;
    }
};

export const maskKey = (key: string): string => {
    if (!key || key.length < 8) return '********';
    return '****' + key.slice(-4);
}
