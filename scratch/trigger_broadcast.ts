import mongoose from 'mongoose';
import { SignalBroadcastService } from '../src/services/SignalBroadcastService';

async function triggerBroadcast() {
    await mongoose.connect('mongodb://localhost:27017/darixoangelone');
    
    const signalId = "69f86f280743598995581c4d";
    console.log('TRIGGERING_BROADCAST_FOR:' + signalId);
    
    try {
        const result = await SignalBroadcastService.broadcast(signalId);
        console.log('BROADCAST_RESULT:' + JSON.stringify(result));
    } catch (err) {
        console.error('BROADCAST_ERROR:' + err.message);
    }
    
    await mongoose.disconnect();
}
triggerBroadcast();
