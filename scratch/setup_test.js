const mongoose = require('mongoose');

async function setupTest() {
    await mongoose.connect('mongodb://localhost:27017/darixoangelone');
    
    // 1. Models
    const User = mongoose.model('User', new mongoose.Schema({
        user_name: String,
        email: String,
        licence: String,
        status: String,
        trading_status: String,
        broker: String,
        client_key: String,
        strategies: [String]
    }));
    
    const Signal = mongoose.model('Signal', new mongoose.Schema({
        symbol: String,
        exchange: String,
        side: String,
        tradingsymbol: String,
        price: Number,
        quantity: Number,
        status: String,
        signalType: String,
        strategy: String,
        symboltoken: String
    }));

    const Instrument = mongoose.model('Instrument', new mongoose.Schema({
        tradingsymbol: String,
        symboltoken: String,
        exchange: String,
        instrument_type: String,
        expiry: String
    }));

    // 2. Create Demo User
    let demoUser = await User.findOne({ email: "test_demo@trustifye.com" });
    if (!demoUser) {
        demoUser = await User.create({
            user_name: "Test Demo User",
            email: "test_demo@trustifye.com",
            licence: "Demo",
            status: "active",
            trading_status: "enabled",
            broker: "ANGELONE",
            strategies: ["Manual"]
        });
        console.log('DEMO_USER_CREATED:' + demoUser._id);
    } else {
        console.log('DEMO_USER_EXISTS:' + demoUser._id);
    }

    // 3. Find a NIFTY CE Instrument
    const niftyCe = await Instrument.findOne({ 
        tradingsymbol: { $regex: /NIFTY.*CE/ },
        exchange: "NFO" 
    }).sort({ expiry: 1 });

    if (!niftyCe) {
        console.log('NIFTY_CE_NOT_FOUND');
        await mongoose.disconnect();
        return;
    }
    console.log('INSTRUMENT_FOUND:' + niftyCe.tradingsymbol + ' | Token:' + niftyCe.symboltoken);

    // 4. Create Signal
    const signal = await Signal.create({
        symbol: "NIFTY",
        exchange: "NFO",
        side: "BUY",
        tradingsymbol: niftyCe.tradingsymbol,
        price: 100,
        quantity: 1,
        status: "ACTIVE",
        signalType: "ENTRY",
        strategy: "Manual",
        symboltoken: niftyCe.symboltoken
    });
    console.log('SIGNAL_CREATED:' + signal._id);

    await mongoose.disconnect();
}
setupTest();
