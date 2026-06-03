import mongoose from "mongoose";
import { config } from "../config";
import User from "../models/User";
import AgentModel from "../models/Agent";
import AgentHeartbeatModel from "../models/AgentHeartbeat";
import SignalDeliveryModel from "../models/SignalDelivery";
import { Signal } from "../models/Signal";
import { SignalExecutionResult } from "../models/SignalExecutionResult";
import { BrokerResponse } from "../models/BrokerResponse";
import { WebSocketAgentServer } from "../services/WebSocketAgentServer";
import { encrypt } from "../utils/encryption";
import WebSocket from "ws";
import crypto from "crypto";

async function run() {
  console.log("Connecting to MongoDB...");
  await mongoose.connect("mongodb://127.0.0.1:27017/darixoangelone");
  console.log("Connected to MongoDB.");

  // 1. Find a test user or create one
  let testUser = await User.findOne({ email: "test_agent_user@example.com" });
  if (!testUser) {
    testUser = await User.create({
      user_name: "Test Agent User",
      email: "test_agent_user@example.com",
      licence: "Live",
      broker: "ANGELONE",
      status: "active",
      trading_status: "enabled",
      broker_connected: true,
      client_key: encrypt("TEST_CODE"),
      api_key: encrypt("TEST_API_KEY"),
      api_key_ip_pair_verified: true,
    });
  }

  // 2. Find or create agent for user
  const rawSecret = "super_secret_agent_key_123456";
  let agent = await AgentModel.findOne({ userId: testUser._id });
  if (!agent) {
    agent = await AgentModel.create({
      userId: testUser._id,
      agentId: "AGENT-TEST-001",
      agentSecret: encrypt(rawSecret),
      status: "active",
      version: "1.0.0"
    });
  } else {
    agent.agentSecret = encrypt(rawSecret);
    await agent.save();
  }

  console.log(`Agent configured: agentId=${agent.agentId}, secret=${rawSecret}`);

  // 3. Connect to WebSocket
  const timestamp = Date.now();
  const signature = crypto
    .createHmac("sha256", rawSecret)
    .update(`${agent.agentId}:${timestamp}`)
    .digest("hex");

  console.log("Connecting to WebSocket gateway at ws://127.0.0.1:4000/ws/agent ...");
  const ws = new WebSocket(`ws://127.0.0.1:4000/ws/agent`, {
    headers: {
      "x-agent-id": agent.agentId,
      "x-timestamp": String(timestamp),
      "x-signature": signature
    }
  });

  ws.on("open", () => {
    console.log("WebSocket connection established successfully!");
    
    // Send a heartbeat
    console.log("Sending heartbeat ping...");
    const heartbeatFrame = {
      event: "HEARTBEAT",
      payload: {
        status: "ONLINE",
        publicIp: "127.0.0.1",
        pingMs: 5,
        metrics: { cpuPercent: 1.2, memFreeBytes: 1024 * 1024, uptimeSeconds: 120 }
      }
    };
    ws.send(JSON.stringify(heartbeatFrame));
  });

  ws.on("message", async (data) => {
    console.log("Received signal frame from server:", data.toString());
    const frame = JSON.parse(data.toString());
    
    if (frame.event === "EXECUTE_SIGNAL") {
      console.log("Validating signal frame signature...");
      const payloadStr = JSON.stringify(frame.payload);
      const expectedSignature = crypto
        .createHmac("sha256", rawSecret)
        .update(`${frame.messageId}:${frame.timestamp}:${payloadStr}`)
        .digest("hex");

      if (crypto.timingSafeEqual(Buffer.from(frame.signature), Buffer.from(expectedSignature))) {
        console.log("Signature is VALID!");
        
        // Return execution callback success
        const callbackFrame = {
          event: "EXECUTION_CALLBACK",
          messageId: frame.messageId,
          agentId: agent.agentId,
          status: "SUCCESS",
          brokerOrderId: "260518000000888",
          clientOrderId: frame.payload.clientOrderId,
          correlationId: frame.payload.correlationId,
          brokerResponse: {
            status: true,
            message: "SUCCESS",
            errorcode: "",
            data: { orderid: "260518000000888" }
          }
        };
        
        console.log("Sending callback response to server...");
        ws.send(JSON.stringify(callbackFrame));
      } else {
        console.error("Signature verification FAILED!");
      }
    }
  });

  ws.on("close", () => {
    console.log("WebSocket connection closed.");
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });

  // Wait 3 seconds for heartbeat to log, then run test broadcast
  setTimeout(async () => {
    console.log("Triggering test signal broadcast from server...");
    
    // Create a dummy signal
    const testSignal = await Signal.create({
      symbol: "NIFTY",
      strategy: "Manual",
      exchange: "NFO",
      tradingsymbol: "NIFTY19MAY2623600CE",
      symboltoken: "54911",
      side: "BUY",
      quantity: 1,
      price: 100.05,
      status: "ACTIVE"
    });

    const axios = require("axios");
    try {
      console.log(`Triggering broadcast via API for user ${testUser._id} and signal ${testSignal._id}...`);
      const response = await axios.post("http://127.0.0.1:4000/api/chaos/test-agent-broadcast", {
        signalId: String(testSignal._id),
        userId: String(testUser._id)
      });
      console.log("Broadcast API response:", response.data);
    } catch (err: any) {
      console.error("Broadcast API call failed:", err.response?.data || err.message);
    }
    
    // Wait another 5 seconds for callback processing, then clean up
    setTimeout(async () => {
      console.log("Verifying database records...");
      
      const hb = await AgentHeartbeatModel.findOne({ agentId: agent.agentId }).sort({ timestamp: -1 });
      console.log("Heartbeat logged IP:", hb?.publicIp);

      const del = await SignalDeliveryModel.findOne({ signalId: testSignal._id });
      console.log("Signal delivery status:", del?.status);

      const exec = await SignalExecutionResult.findOne({ signalId: testSignal._id });
      console.log("Execution Result status:", exec?.status, "Broker Order ID:", exec?.orderId);

      const br = await BrokerResponse.findOne({ userId: String(testUser._id) }).sort({ createdAt: -1 });
      console.log("Broker Response Status:", br?.status, "Message:", br?.message);

      ws.close();
      await mongoose.disconnect();
      console.log("Verification finished.");
    }, 5000);

  }, 3000);
}

run().catch(console.error);
