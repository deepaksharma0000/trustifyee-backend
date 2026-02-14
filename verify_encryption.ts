
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from './src/models/User';
import AngelTokensModel from './src/models/AngelTokens';
import { decrypt } from './src/utils/encryption';

dotenv.config();

const verifyEncryption = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI as string);
        console.log("Connected to MongoDB");

        // 1. Check a recently created User
        const user = await User.findOne({}).sort({ createdAt: -1 });
        if (user) {
            console.log("\n--- Latest User ---");
            console.log("User Name:", user.user_name);
            console.log("Raw Client Key (DB):", user.client_key); // Should look like iv:ciphertext
            console.log("Raw API Key (DB):", user.api_key);       // Should look like iv:ciphertext

            if (user.client_key && user.client_key.includes(':')) {
                console.log("Decrypted Client Key:", decrypt(user.client_key));
                console.log("✅ Client Key is ENCRYPTED in DB");
            } else {
                console.log("⚠️ Client Key is NOT encrypted (or legacy data)");
            }
        } else {
            console.log("No users found.");
        }

        // 2. Check Angel Tokens
        const angelToken = await AngelTokensModel.findOne({});
        if (angelToken) {
            console.log("\n--- Angel Token ---");
            console.log("Client Code:", angelToken.clientcode);
            console.log("Raw JWT (DB):", angelToken.jwtToken?.substring(0, 50) + "...");

            if (angelToken.jwtToken && angelToken.jwtToken.includes(':')) {
                console.log("✅ JWT Token is ENCRYPTED in DB");
                // console.log("Decrypted JWT:", decrypt(angelToken.jwtToken)); // Too long to print usually
            } else {
                console.log("⚠️ JWT Token is NOT encrypted");
            }
        } else {
            console.log("No Angel tokens found.");
        }

        mongoose.disconnect();

    } catch (error) {
        console.error("Error:", error);
        process.exit(1);
    }
};

verifyEncryption();
