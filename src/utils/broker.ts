import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import User, { IUser } from "../models/User";
import Admin, { IAdmin } from "../models/Admin";
import { decrypt } from "./encryption";
import { log } from "./logger";

/**
 * Lazy Factory for AngelOneAdapter
 * Fetches user/admin from DB, decrypts API key, and creates adapter instance.
 */
export async function createAngelAdapter(userIdOrDoc: string | IUser | IAdmin): Promise<AngelOneAdapter> {
    let user: IUser | IAdmin | null = null;

    if (typeof userIdOrDoc === 'string') {
        const userId = userIdOrDoc;
        user = await User.findById(userId) || (await import('../models/Admin')).default.findById(userId);
    } else {
        user = userIdOrDoc;
    }

    if (!user) {
        throw new Error("Adapter creation failed: User/Admin profile not found.");
    }

    const encKey = user.api_key;
    if (!encKey) {
        log.error(`[INVALID_ADAPTER_STATE] API Key missing for ${user._id}`);
        throw new Error("Missing Broker API Key. Please update your profile.");
    }

    const decKey = decrypt(encKey, "broker_adapter_factory");
    if (!decKey || decKey.length < 10) {
        log.error(`[INVALID_ADAPTER_STATE] Decrypted API Key invalid for ${user._id}`);
        throw new Error("Invalid Decrypted API Key. Please reconnect broker.");
    }

    return new AngelOneAdapter(decKey, user.outgoing_ip);
}
