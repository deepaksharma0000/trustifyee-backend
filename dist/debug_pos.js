"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const Position_model_1 = require("./models/Position.model");
const config_1 = require("./config");
async function check() {
    await mongoose_1.default.connect(config_1.config.mongoUri);
    const orderid = "BROKER-a0eb5877-bbbb-454b-902b-b0c83bf96dcc";
    const pos = await Position_model_1.Position.findOne({ orderid });
    console.log("Position Data:", JSON.stringify(pos, null, 2));
    if (pos) {
        console.log("autoSquareOffTime (raw):", pos.autoSquareOffTime);
        console.log("Current Server Time:", new Date().toISOString());
        console.log("Is Time Reached?", new Date() >= new Date(pos.autoSquareOffTime));
    }
    await mongoose_1.default.disconnect();
}
check();
