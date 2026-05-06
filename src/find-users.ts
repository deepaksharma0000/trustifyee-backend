import mongoose from "mongoose";
import User from "./models/User";
import dotenv from "dotenv";
import { decrypt } from "./utils/encryption";

dotenv.config();

async function findUser() {
    await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/darixoangelone");
    const users = await User.find({ broker_connected: true }).lean();
    console.log(`Found ${users.length} connected users`);
    for (const user of users) {
        console.log(`User: ${user.user_name}, Email: ${user.email}, ID: ${user._id}`);
        console.log(`Decrypted Client Key: ${decrypt(user.client_key || "")}`);
    }
    await mongoose.disconnect();
}

findUser();
