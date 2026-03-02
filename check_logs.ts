import mongoose from 'mongoose';
import { config } from '../src/config';
import BrokerResponse from '../src/models/BrokerResponse';

async function checkLogs() {
    await mongoose.connect(config.mongoUri);
    const logs = await BrokerResponse.find().sort({ createdAt: -1 }).limit(5).lean();
    console.log(JSON.stringify(logs, null, 2));
    await mongoose.disconnect();
}

checkLogs().catch(console.error);
