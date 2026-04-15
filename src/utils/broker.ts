import { Types } from "mongoose";
import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import User, { IUser } from "../models/User";
import Admin, { IAdmin } from "../models/Admin";
import { decrypt } from "./encryption";
import { log } from "./logger";

/**
 * Safe conversion of ID to string
 */
export const toUserId = (id: string | Types.ObjectId | null | undefined): string => {
    if (!id) return "";
    return typeof id === 'string' ? id : id.toString();
};

/**
 * Lazy Factory for AngelOneAdapter
 * Fetches user/admin from DB, decrypts API key, and creates adapter instance.
 */
export async function createAngelAdapter(userIdOrDoc: string | Types.ObjectId | IUser | IAdmin): Promise<AngelOneAdapter> {
    if (!userIdOrDoc) {
        throw new Error("[ADAPTER_FACTORY_ERROR] No user context provided.");
    }

    let user: IUser | IAdmin | null = null;

    // 1. If it's a string or ObjectId, fetch from DB
    const possibleId = toUserId(userIdOrDoc as string | Types.ObjectId);
    const isId = possibleId.length > 5 && !possibleId.includes("{");

    if (isId) {
        // Use .lean() to get a plain JS object (avoids Mongoose query overhead)
        user = await User.findById(possibleId).lean() as IUser | null;
        if (!user) {
            user = await Admin.findById(possibleId).lean() as IAdmin | null;
        }
    } else {
        // 2. Already an object (IUser or IAdmin)
        user = userIdOrDoc as IUser | IAdmin;
    }

    if (!user) {
        log.error(`[ADAPTER_FACTORY_ERROR] User profile not found for ID: ${possibleId}`);
        throw new Error("Adapter creation failed: Broker profile not found.");
    }

    const encKey = user.api_key;
    if (!encKey) {
        log.error(`[INVALID_ADAPTER_STATE] API Key missing for user: ${toUserId(user._id)}`);
        throw new Error("Missing Broker API Key. Please update your profile.");
    }

    const userIdent = `user_${toUserId(user._id)}`;
    const { safeDecrypt } = require("./encryption");
    const decKey = safeDecrypt(encKey, userIdent);
    
    if (!decKey || decKey.length < 5) {
        log.error(`[INVALID_ADAPTER_STATE] Decrypted API Key invalid/missing for user: ${userIdent}. RawKey: ${encKey.substring(0, 5)}...`);
        throw new Error("Invalid Decrypted API Key. Please reconnect broker in your profile.");
    }

    return new AngelOneAdapter(decKey, user.outgoing_ip);
}
