# Trustifyee Decentralized Execution Agent

This is the decentralized execution agent client for the Trustifyee Trading System. It runs locally on your PC or VPS and executes orders directly via the Angel One SmartAPI, whitelisting your local IP.

## Installation

1. Install Node.js (LTS version recommended, e.g. Node.js 18 or 20) on your machine.
2. Extract the agent ZIP file.
3. Open a terminal/command prompt in the extracted directory.
4. Run `npm install` to install dependencies.

## Configuration

1. Copy `.env.example` to `.env`.
2. Fill in the variables:
   - `AGENT_ID`: Your Agent ID from the Trustifyee Portal.
   - `AGENT_SECRET`: Your Agent Secret Token from the Trustifyee Portal.
   - `BACKEND_WS_URL`: The WebSocket URL of your backend (e.g. `wss://yourdomain.com/ws/agent`).
   - `ANGEL_CLIENT_CODE`: Your Angel One login Client ID (e.g. `A123456`).
   - `ANGEL_PASSWORD`: Your Angel One MPIN / password.
   - `ANGEL_API_KEY`: Your Angel One SmartAPI app key.
   - `ANGEL_TOTP_SECRET`: Your Angel One 16-character TOTP secret key.

## Run

To start the agent:
```bash
npm start
```
