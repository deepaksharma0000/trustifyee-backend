import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const run = async () => {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/darixoangelone';
    console.log("Connecting to Mongo URI:", mongoUri);
    await mongoose.connect(mongoUri);
    console.log("Connected successfully!");

    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    console.log("\nCollections in Database:", collections.map(c => c.name));

    // 1. Users count and summary
    const usersCol = db.collection('users');
    const userCount = await usersCol.countDocuments();
    console.log(`\n--- Users (Total: ${userCount}) ---`);
    const users = await usersCol.find({}).toArray();
    console.log(JSON.stringify(users.map(u => ({
      _id: u._id,
      user_name: u.user_name,
      email: u.email,
      licence: u.licence,
      broker: u.broker,
      trading_paused: u.trading_paused,
      consecutive_failures: u.consecutive_failures,
      dedicated_ip_enabled: u.dedicated_ip_enabled,
      api_key_ip_pair_verified: u.api_key_ip_pair_verified,
      validated_route_ip: u.validated_route_ip,
      validated_route_type: u.validated_route_type,
    })), null, 2));

    // 2. Angel Tokens summary
    const tokensCol = db.collection('angeltokens');
    const tokenCount = await tokensCol.countDocuments();
    console.log(`\n--- Angel Tokens (Total: ${tokenCount}) ---`);
    const tokens = await tokensCol.find({}).toArray();
    console.log(JSON.stringify(tokens.map(t => ({
      _id: t._id,
      userId: t.userId,
      clientcode: t.clientcode,
      updatedAt: t.updatedAt,
      hasJwt: !!t.jwtToken,
      hasRefresh: !!t.refreshToken,
      hasFeedToken: !!t.feedToken
    })), null, 2));

    // 3. Broker Responses summary
    const brokerRespCol = db.collection('brokerresponses');
    const brokerRespCount = await brokerRespCol.countDocuments();
    console.log(`\n--- Broker Responses (Total: ${brokerRespCount}) ---`);
    const responses = await brokerRespCol.find({}).sort({ createdAt: -1 }).limit(10).toArray();
    console.log(JSON.stringify(responses, null, 2));

    // 4. Signal Execution Results summary
    const signalResultsCol = db.collection('signalexecutionresults');
    const signalResultsCount = await signalResultsCol.countDocuments();
    console.log(`\n--- Signal Execution Results (Total: ${signalResultsCount}) ---`);
    const signalResults = await signalResultsCol.find({}).sort({ executedAt: -1 }).limit(10).toArray();
    console.log(JSON.stringify(signalResults, null, 2));

    // 5. Signals count and summary if exists
    if (collections.some(c => c.name === 'signals')) {
      const signalsCol = db.collection('signals');
      const signalCount = await signalsCol.countDocuments();
      console.log(`\n--- Signals (Total: ${signalCount}) ---`);
      const signals = await signalsCol.find({}).sort({ createdAt: -1 }).limit(5).toArray();
      console.log(JSON.stringify(signals, null, 2));
    } else {
      console.log("\nSignals collection does not exist.");
    }

    // 6. OMS Events summary if exists
    if (collections.some(c => c.name === 'omsevents')) {
      const omsEventsCol = db.collection('omsevents');
      const omsEventsCount = await omsEventsCol.countDocuments();
      console.log(`\n--- OMS Events (Total: ${omsEventsCount}) ---`);
      const omsEvents = await omsEventsCol.find({}).sort({ timestamp: -1 }).limit(10).toArray();
      console.log(JSON.stringify(omsEvents, null, 2));
    } else {
      console.log("\nomsevents collection does not exist.");
    }

    await mongoose.disconnect();
  } catch (err) {
    console.error("Database query failed:", err);
  }
};

run();
