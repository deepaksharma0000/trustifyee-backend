import mongoose from 'mongoose';

const run = async () => {
  try {
    const uri = 'mongodb://127.0.0.1:27017/angelone';
    console.log("Connecting to:", uri);
    await mongoose.connect(uri);
    console.log("Connected successfully!");

    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log("\nCollections in current DB:", collections.map(c => c.name));

    for (const col of collections) {
      const count = await mongoose.connection.db.collection(col.name).countDocuments();
      console.log(`- ${col.name}: ${count} documents`);
    }

    // Print latest broker responses
    console.log("\n--- Latest Broker Responses ---");
    const brokerResponses = await mongoose.connection.db.collection('brokerresponses')
      .find({})
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();
    console.log(JSON.stringify(brokerResponses, null, 2));

    // Print latest user
    console.log("\n--- Latest Users ---");
    const users = await mongoose.connection.db.collection('users')
      .find({})
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();
    console.log(JSON.stringify(users.map(u => ({ _id: u._id, user_name: u.user_name, email: u.email, licence: u.licence })), null, 2));

    // Print latest angel tokens
    console.log("\n--- Latest Angel Tokens ---");
    const tokens = await mongoose.connection.db.collection('angeltokens')
      .find({})
      .sort({ updatedAt: -1 })
      .limit(5)
      .toArray();
    console.log(JSON.stringify(tokens.map(t => ({ _id: t._id, userId: t.userId, clientcode: t.clientcode, hasJwt: !!t.jwtToken })), null, 2));

    await mongoose.disconnect();
  } catch (error) {
    console.error("Error:", error);
  }
};

run();
