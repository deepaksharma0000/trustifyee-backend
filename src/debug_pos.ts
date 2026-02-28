
import mongoose from 'mongoose';
import { Position } from './models/Position.model';
import { config } from './config';

async function check() {
    await mongoose.connect(config.mongoUri);
    const orderid = "BROKER-a0eb5877-bbbb-454b-902b-b0c83bf96dcc";
    const pos = await Position.findOne({ orderid });
    console.log("Position Data:", JSON.stringify(pos, null, 2));
    if (pos) {
        console.log("autoSquareOffTime (raw):", pos.autoSquareOffTime);
        console.log("Current Server Time:", new Date().toISOString());
        console.log("Is Time Reached?", new Date() >= new Date(pos.autoSquareOffTime!));
    }
    await mongoose.disconnect();
}

check();
