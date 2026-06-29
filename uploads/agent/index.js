const WebSocket = require('ws');
const crypto = require('crypto');
const axios = require('axios');
const speakeasy = require('speakeasy');
require('dotenv').config();

const AGENT_ID = process.env.AGENT_ID;
const AGENT_SECRET = process.env.AGENT_SECRET;
const BACKEND_WS_URL = process.env.BACKEND_WS_URL;

// Angel One Credentials
const ANGEL_CLIENT_CODE = process.env.ANGEL_CLIENT_CODE;
const ANGEL_PASSWORD = process.env.ANGEL_PASSWORD;
const ANGEL_API_KEY = process.env.ANGEL_API_KEY;
const ANGEL_TOTP_SECRET = process.env.ANGEL_TOTP_SECRET;
const ASSIGNED_EXECUTION_IP = process.env.AGENT_ASSIGNED_EXECUTION_IP || '';

if (!AGENT_ID || !AGENT_SECRET || !BACKEND_WS_URL) {
  console.error("FATAL ERROR: AGENT_ID, AGENT_SECRET, and BACKEND_WS_URL are required in .env");
  process.exit(1);
}

if (!ANGEL_CLIENT_CODE || !ANGEL_PASSWORD || !ANGEL_API_KEY || !ANGEL_TOTP_SECRET) {
  console.warn("WARNING: Angel One credentials (ANGEL_CLIENT_CODE, ANGEL_PASSWORD, ANGEL_API_KEY, ANGEL_TOTP_SECRET) are missing or incomplete in .env. Execution might fail.");
}

let ws = null;
let heartbeatInterval = null;
let localIp = '127.0.0.1';
const macAddress = '02:00:00:00:00:00';

// Angel One Session Cache
let angelSession = {
  jwtToken: null,
  refreshToken: null,
  expiresAt: null
};

// Utility function to get local IP address
function getLocalIpAddress() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

try {
  localIp = getLocalIpAddress();
} catch (e) {
  // Ignore
}

// Get public IP
async function getPublicIp() {
  try {
    const res = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
    return res.data.ip;
  } catch (err) {
    try {
      const res = await axios.get('https://icanhazip.com', { timeout: 5000 });
      return res.data.trim();
    } catch {
      return '127.0.0.1';
    }
  }
}

// Generate TOTP
function generateTOTP(secret) {
  return speakeasy.totp({
    secret: secret.trim().toUpperCase(),
    encoding: 'base32'
  });
}

// Login to Angel One
async function loginToAngelOne() {
  console.log(`[AngelOne] Logging in for client ${ANGEL_CLIENT_CODE}...`);
  const totp = generateTOTP(ANGEL_TOTP_SECRET);
  const payload = {
    clientcode: ANGEL_CLIENT_CODE.trim().toUpperCase(),
    password: ANGEL_PASSWORD.trim(),
    totp: totp
  };

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': localIp,
    'X-ClientPublicIP': await getPublicIp(),
    'X-MACAddress': macAddress,
    'X-PrivateKey': ANGEL_API_KEY.trim(),
    'X-Api-Key': ANGEL_API_KEY.trim()
  };

  try {
    const res = await axios.post('https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword', payload, { headers });
    if (res.data && res.data.status && res.data.data) {
      console.log(`[AngelOne] Login successful! Session token acquired.`);
      angelSession = {
        jwtToken: res.data.data.jwtToken,
        refreshToken: res.data.data.refreshToken,
        expiresAt: Date.now() + 18 * 60 * 60 * 1000 // 18 hours validity
      };
      return angelSession.jwtToken;
    } else {
      throw new Error(res.data.message || res.data.emsg || 'Unknown login error');
    }
  } catch (err) {
    const errMsg = err.response?.data?.message || err.response?.data?.emsg || err.message;
    console.error(`[AngelOne] Login failed: ${errMsg}`);
    throw new Error(`Angel One Auth Failed: ${errMsg}`);
  }
}

// Get Active JWT Token
async function getJwtToken() {
  if (angelSession.jwtToken && angelSession.expiresAt && Date.now() < angelSession.expiresAt) {
    return angelSession.jwtToken;
  }
  return await loginToAngelOne();
}

// Place Order to Angel One
async function placeAngelOrder(orderPayload) {
  const jwtToken = await getJwtToken();
  const publicIp = await getPublicIp();

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': localIp,
    'X-ClientPublicIP': publicIp,
    'X-MACAddress': macAddress,
    'X-PrivateKey': ANGEL_API_KEY.trim(),
    'X-Api-Key': ANGEL_API_KEY.trim(),
    'Authorization': `Bearer ${jwtToken}`
  };

  const payload = {
    variety: 'NORMAL',
    tradingsymbol: orderPayload.tradingsymbol,
    symboltoken: orderPayload.symboltoken,
    transactiontype: orderPayload.transactiontype,
    exchange: orderPayload.exchange || 'NFO',
    ordertype: orderPayload.ordertype || 'MARKET',
    producttype: orderPayload.producttype || 'INTRADAY',
    duration: orderPayload.duration || 'DAY',
    price: String(orderPayload.price || 0),
    quantity: String(orderPayload.quantity),
    triggerprice: '0'
  };

  console.log(`[AngelOne] Outbound API Request -> placing order for ${payload.tradingsymbol} Qty ${payload.quantity}...`);
  const res = await axios.post('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/placeOrder', payload, { headers });
  
  if (res.data && res.data.status === true && res.data.data) {
    return res.data;
  } else {
    // If invalid token, clear session cache
    if (res.data && (res.data.errorcode === 'AG8001' || String(res.data.message || '').includes('Invalid Token'))) {
      angelSession = { jwtToken: null, refreshToken: null, expiresAt: null };
    }
    throw new Error(res.data.message || res.data.emsg || 'Order placement rejected by broker');
  }
}

// Connect to WebSocket Gateway
async function connect() {
  console.log(`[Agent] Initializing Decentralized Execution Agent (ID: ${AGENT_ID})...`);

  const timestamp = Date.now();
  const signature = crypto
    .createHmac('sha256', AGENT_SECRET)
    .update(`${AGENT_ID}:${timestamp}`)
    .digest('hex');

  console.log(`[Agent] Connecting to websocket gateway at ${BACKEND_WS_URL}...`);

  ws = new WebSocket(BACKEND_WS_URL, {
    headers: {
      'x-agent-id': AGENT_ID,
      'x-timestamp': String(timestamp),
      'x-signature': signature
    }
  });

  ws.on('open', async () => {
    const publicIp = await getPublicIp();
    console.log(`[Agent] Agent connected`);
    console.log(`[Agent] Websocket authenticated`);
    console.log(`[Agent] Connected IP reported: ${publicIp}`);

    // Start sending heartbeat
    sendHeartbeat();
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(sendHeartbeat, 15000);
  });

  ws.on('message', async (data) => {
    try {
      const frame = JSON.parse(data.toString());
      if (frame.event === 'EXECUTE_SIGNAL') {
        console.log(`[Agent] Signal received`);
        console.log(`[Signal] Signal Details: Symbol=${frame.payload.tradingsymbol}, Side=${frame.payload.transactiontype}, Qty=${frame.payload.quantity}`);
        
        // Verify signature
        const payloadStr = JSON.stringify(frame.payload);
        const expectedSignature = crypto
          .createHmac('sha256', AGENT_SECRET)
          .update(`${frame.messageId}:${frame.timestamp}:${payloadStr}`)
          .digest('hex');

        if (!crypto.timingSafeEqual(Buffer.from(frame.signature), Buffer.from(expectedSignature))) {
          console.error('[Signal] Signature verification FAILED! Discarding signal.');
          return;
        }

        console.log('[Order] Order execution started');

        let callbackFrame = {
          event: 'EXECUTION_CALLBACK',
          messageId: frame.messageId,
          agentId: AGENT_ID,
          clientOrderId: frame.payload.clientOrderId,
          correlationId: frame.payload.correlationId
        };

        try {
          const brokerResp = await placeAngelOrder(frame.payload);
          console.log(`[Order] SUCCESS: Order placed with Broker Order ID: ${brokerResp.data.orderid}`);
          
          callbackFrame.status = 'SUCCESS';
          callbackFrame.brokerOrderId = brokerResp.data.orderid;
          callbackFrame.brokerResponse = brokerResp;
        } catch (err) {
          console.error(`[Order] FAILED: ${err.message}`);
          callbackFrame.status = 'FAILED';
          callbackFrame.errorMessage = err.message;
          callbackFrame.brokerResponse = err.response?.data || { status: false, message: err.message };
        }

        console.log('[Agent] Sending execution callback to server...');
        ws.send(JSON.stringify(callbackFrame));
      }
    } catch (err) {
      console.error('[Agent] Error handling websocket message:', err.message);
    }
  });

  ws.on('close', (code, reason) => {
    console.warn(`[Agent] WebSocket connection closed (Code: ${code}, Reason: ${reason}). Reconnecting in 5 seconds...`);
    cleanup();
    setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    console.error(`[Agent] WebSocket connection error: ${err.message}`);
  });
}

async function sendHeartbeat() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const publicIp = await getPublicIp();
  const uptime = process.uptime();
  const memory = process.memoryUsage();

  const heartbeatFrame = {
    event: 'HEARTBEAT',
    payload: {
      status: 'ONLINE',
      publicIp: publicIp,
      assignedExecutionIp: ASSIGNED_EXECUTION_IP || undefined,
      pingMs: 5,
      metrics: {
        cpuPercent: 1.0,
        memFreeBytes: memory.heapTotal - memory.heapUsed,
        uptimeSeconds: Math.floor(uptime)
      }
    }
  };

  console.log(`[Agent] Heartbeat sent`);
  ws.send(JSON.stringify(heartbeatFrame));
}

function cleanup() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

connect().catch(err => {
  console.error('[Agent] Fatal startup error:', err);
});
