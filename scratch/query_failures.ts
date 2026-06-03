import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const forceIpv4Uri = (uri: string): string => {
  if (!uri) return uri;
  return uri.replace("localhost", "127.0.0.1").replace("[::1]", "127.0.0.1");
};

const run = async () => {
  try {
    let mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/darixoangelone';
    mongoUri = forceIpv4Uri(mongoUri);
    console.log("Connecting to Mongo URI:", mongoUri);
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
    console.log("Connected successfully!");

    const db = mongoose.connection.db;

    console.log("\n--- Querying FAILED/REJECTED Broker Responses ---");
    const rejectedResponses = await db.collection('brokerresponses')
      .find({ status: 'REJECTED' })
      .sort({ createdAt: -1 })
      .limit(30)
      .toArray();

    console.log(`Found ${rejectedResponses.length} rejected responses (showing latest 30):`);
    console.log(JSON.stringify(rejectedResponses, null, 2));

    console.log("\n--- Unique Rejection Messages ---");
    const uniqueMessages = await db.collection('brokerresponses').distinct('message', { status: 'REJECTED' });
    console.log(JSON.stringify(uniqueMessages, null, 2));

    console.log("\n--- Signal Execution Failures ---");
    const failedSignals = await db.collection('signalexecutionresults')
      .find({ status: 'FAILED' })
      .sort({ executedAt: -1 })
      .limit(30)
      .toArray();
    console.log(JSON.stringify(failedSignals, null, 2));

    console.log("\n--- Unique Signal Failure Error Messages ---");
    const uniqueSignalErrors = await db.collection('signalexecutionresults').distinct('errorMessage', { status: 'FAILED' });
    console.log(JSON.stringify(uniqueSignalErrors, null, 2));

    await mongoose.disconnect();
  } catch (err) {
    console.error("Query failed:", err);
  }
};

run();
