import crypto from 'crypto';
import { config } from '../config';
import log from './logger';

const ENCRYPTION_PREFIX = 'enc::';
const ENCRYPTION_KEY = config.encryptionKey || 'your-default-secure-key-32-chars-long'; // Fallback for dev only
const IV_LENGTH = 16; // AES block size
const ENCRYPTION_VERBOSE = process.env.ENCRYPTION_VERBOSE === 'true';

// Ensure key is 32 bytes (256 bits)
const getKey = () => {
    return crypto.createHash('sha256').update(String(ENCRYPTION_KEY)).digest();
};

/**
 * Checks if a string is already migrated/encrypted with the new format (enc:: prefix)
 */
export const isMigrated = (text: string): boolean => {
    return !!text && text.startsWith(ENCRYPTION_PREFIX);
};

export const encrypt = (text: string): string => {
    if (!text) return text;
    // Don't re-encrypt if already has prefix (unless you want double encryption, usually avoid)
    if (isMigrated(text)) return text; 

    try {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv('aes-256-cbc', getKey(), iv);
        let encrypted = cipher.update(text);
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        return ENCRYPTION_PREFIX + iv.toString('hex') + ':' + encrypted.toString('hex');
    } catch (error) {
        console.error('Encryption failed:', error);
        return text; 
    }
};

/**
 * Safe Decrypt strategy for Production Hardening
 * 1. If no "enc::" prefix -> return as-is (plaintext)
 * 2. If "enc::" prefix -> attempt decryption
 * 3. [STRICT] If decryption fails -> return NULL and log error
 */
export const safeDecrypt = (text: string, identifier: string = 'field'): string | null => {
    if (!text) return null;
    
    const maskedRaw = text.length > 10 ? text.substring(0, 10) + '...' : text;
    const hasPrefix = isMigrated(text);

    // If it doesn't have the prefix, treat as plaintext OR legacy iv:ciphertext format
    if (!hasPrefix) {
        const textParts = text.split(':');
        if (textParts.length === 2) {
            const [ivHex, encryptedHex] = textParts;
            const hexRegex = /^[0-9a-fA-F]+$/;
            if (hexRegex.test(ivHex) && hexRegex.test(encryptedHex) && ivHex.length === 32) {
                // High-visibility telemetry log for legacy migration path
                log.info(`[DECRYPTION_INFO] [LEGACY_ENCRYPTED_FORMAT_DETECTED] [${identifier}] Field: ${identifier}`);
                try {
                    const iv = Buffer.from(ivHex, 'hex');
                    const encryptedText = Buffer.from(encryptedHex, 'hex');
                    const decipher = crypto.createDecipheriv('aes-256-cbc', getKey(), iv);
                    let decrypted = decipher.update(encryptedText);
                    decrypted = Buffer.concat([decrypted, decipher.final()]);
                    const result = decrypted.toString('utf8');
                    if (result && result.length > 0) {
                        log.info(`%c[DECRYPTION_SUCCESS] [${identifier}] Decrypted legacy format successfully. Client Code resolved: ${result}`, "color: #4caf50; font-weight: bold;");
                        return result;
                    }
                } catch (err: any) {
                    log.error(`[DECRYPTION_FAILURE] [LEGACY_DECRYPT_FAILED] [${identifier}] Failed to decrypt legacy format: ${err.message}`);
                }
            }
        }

        // [AUDIT] Log that we are using legacy plaintext
        if (ENCRYPTION_VERBOSE && text.length > 5) {
            log.debug(`[DECRYPTION_INFO] [PLAINTEXT_DETECTED] [${identifier}] Field: ${identifier}`);
        }
        return text;
    }

    // Strip prefix
    const rawData = text.substring(ENCRYPTION_PREFIX.length);
    const textParts = rawData.split(':');
    
    if (textParts.length < 2) {
        log.warn(`[DECRYPTION_FAILURE] [INVALID_FORMAT] [${identifier}] Data: ${maskedRaw} - Expected iv:data`);
        return null;
    }

    try {
        const ivHex = textParts.shift()!;
        const encryptedHex = textParts.join(':');
        
        const iv = Buffer.from(ivHex, 'hex');
        const encryptedText = Buffer.from(encryptedHex, 'hex');
        
        const decipher = crypto.createDecipheriv('aes-256-cbc', getKey(), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        
        const result = decrypted.toString('utf8');
        if (!result || result.length < 1) {
             log.error(`[DECRYPTION_FAILURE] [EMPTY_RESULT] [${identifier}] Decryption succeeded but resulted in empty string.`);
             return null;
        }

        // [DEBUG] Success log (masked)
        if (ENCRYPTION_VERBOSE) {
            log.debug(`[DECRYPTION_SUCCESS] [${identifier}] Decrypted successfully. Preview: ${result.substring(0, 4)}****`);
        }
        
        return result;
    } catch (error: any) {
        // [AUDIT LOG] track records that failed decryption (likely key mismatch or corrupted iv)
        log.error(`[DECRYPTION_FAILURE] [BAD_DECRYPT] [${identifier}] Possible key mismatch. Msg: ${error.message} | Raw: ${maskedRaw}`);
        return null;
    }
};

// Legacy alias for compatibility, mapped to safeDecrypt
export const decrypt = (text: string, id: string = 'field'): string => safeDecrypt(text, id) || "";

/**
 * Automigration Helper:
 * If value is not migrated (no enc:: prefix), encrypt it and save back to DB.
 * Returns the DECRYPTED value for immediate use.
 */
export const ensureEncrypted = async (doc: any, field: string, identifier: string = 'unknown'): Promise<string> => {
    const value = doc[field];
    if (!value) return "";
    
    // [HARDENING] If value is too short, reject
    if (value.length < 5) {
        log.warn(`[AUTO_MIGRATION_REJECTED] [${identifier}] Field: ${field} - Value too short (<5 chars).`);
        return "";
    }

    if (isMigrated(value)) {
        const testDec = safeDecrypt(value, identifier);
        if (!testDec) {
            log.error(`[AUTO_MIGRATION_ERROR] [CORRUPTED_DATA] [${identifier}] Field: ${field} - Decryption failed on already-prefixed data. Likely OLD encryption key.`);
            return ""; // Refuse to use corrupted data
        }
        return testDec;
    }
    
    // Legacy plaintext -> Encrypt it
    const encrypted = encrypt(value);
    if (ENCRYPTION_VERBOSE) {
        log.info(`[AUTO_MIGRATION_SUCCESS] [${identifier}] Field: ${field} - Legacy plaintext upgraded.`);
    }
    
    doc[field] = encrypted;
    if (typeof doc.save === 'function') {
        await doc.save();
    }
    
    return value; 
};

export const validateApiKey = (key: string | null | undefined): boolean => {
    if (!key) return false;
    const clean = isMigrated(key) ? safeDecrypt(key, 'validation') : key;
    return !!(clean && clean.length > 5);
};

export const maskKey = (key: string): string => {
    if (!key || key.trim() === "") return "";
    const clean = decrypt(key, 'masking'); 
    if (!clean || clean.length < 4) return "****";
    return clean.substring(0, 4) + '...';
};

export const matchesEncryptedValue = (encryptedOrPlain: string, candidate: string): boolean => {
    if (!encryptedOrPlain || !candidate) return false;
    const decrypted = safeDecrypt(encryptedOrPlain, "match_check");
    return decrypted === candidate;
};
