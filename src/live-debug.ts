import axios from 'axios';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config();

async function debugLive() {
    console.log('--- LIVE DEBUGGER ---');
    console.log('API KEY from .env:', process.env.ANGEL_API_KEY);
    
    try {
        const ipRes = await axios.get('https://api.ipify.org');
        console.log('Your LIVE Server Public IP:', ipRes.data);
        console.log('Make sure this IP is Whitelisted in AngelOne Dashboard!');
    } catch (e) {
        console.log('Could not fetch IP:', e.message);
    }

    console.log('---------------------');
}

debugLive();
