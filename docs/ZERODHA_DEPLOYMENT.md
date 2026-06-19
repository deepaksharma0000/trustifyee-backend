# Zerodha Kite Connect — Production Deployment Guide

## Overview

Trustifyee supports Zerodha as an isolated broker adapter alongside Angel One and Upstox. Copy trading, BullMQ workers, encrypted credentials, and session validation are fully integrated.

## Architecture

```
Admin Signal
  → SignalBroadcastService (filters by broker)
  → TradeOutbox
  → BullMQ queue: trade-execution-zerodha
  → TradeExecutionWorker
  → OrderService.placeOrderForClient()
  → BrokerAdapterRegistry → ZerodhaAdapter.placeOrder()
```

## Folder Structure

```
trustifyee-backend/src/
├── adapters/
│   ├── IBrokerAdapter.ts          # Common broker interface
│   ├── BrokerAdapterRegistry.ts   # Factory (Angel / Upstox / Zerodha / Alice)
│   ├── AngelOneAdapter.ts         # Unchanged
│   ├── UpstoxAdapter.ts           # Unchanged
│   └── ZerodhaAdapter.ts          # Kite Connect HTTP client
├── controllers/
│   └── ZerodhaController.ts       # Auth + portfolio endpoints
├── routes/
│   └── zerodhaAuth.ts             # Mounted at /api/zerodha
├── services/
│   ├── ZerodhaSessionService.ts   # OAuth, token lifecycle, disconnect alerts
│   ├── OrderService.ts            # Routes Zerodha via adapter
│   ├── SignalBroadcastService.ts  # Includes ZERODHA in copy trading
│   └── TokenRefreshScheduler.ts   # Validates Zerodha sessions every 15 min
├── models/
│   └── User.ts                    # zerodha_* credential fields
└── scripts/
    └── migrateZerodhaFields.ts      # One-time DB migration
```

## Environment Variables

Add to `.env` (production):

```env
# Zerodha Kite Connect (platform app — used when user has no per-user keys)
ZERODHA_API_KEY=your_kite_connect_api_key
ZERODHA_API_SECRET=your_kite_connect_api_secret
ZERODHA_REDIRECT_URI=https://api.yourdomain.com/api/zerodha/callback
ZERODHA_BASE_URL=https://api.kite.trade

# Required existing vars
ENCRYPTION_SECRET=minimum_32_character_secret_key_here
MONGO_URI=mongodb://...
REDIS_URL=redis://...
FRONTEND_URL=https://app.yourdomain.com
```

Register `ZERODHA_REDIRECT_URI` exactly in the [Kite Connect developer console](https://developers.kite.trade/).

## Database Migration

Run once before or after deploy:

```bash
cd trustifyee-backend
npx ts-node src/scripts/migrateZerodhaFields.ts
```

This initializes `zerodha_connected` / `zerodha_verified` defaults and encrypts any plaintext Zerodha credential fields.

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/zerodha/connect` | User JWT | Start OAuth — returns `auth_url` |
| GET | `/api/zerodha/callback` | Public | Kite redirect — exchanges `request_token` |
| POST | `/api/zerodha/refresh` | User JWT | Validate session via profile API |
| POST | `/api/zerodha/disconnect` | User JWT | Logout + clear tokens |
| GET | `/api/zerodha/profile` | User JWT | User profile + broker status |
| GET | `/api/zerodha/status` | User JWT | Connected / Disconnected / Expired |
| GET | `/api/zerodha/orders` | User JWT | Order book |
| GET | `/api/zerodha/positions` | User JWT | Positions |
| GET | `/api/zerodha/holdings` | User JWT | Holdings |
| GET | `/api/zerodha/funds` | User JWT | Margins |
| GET | `/api/zerodha/admin/status/:id` | Admin JWT | Admin view of user broker status |

### OAuth Flow

1. Frontend calls `POST /api/zerodha/connect` (optional: `{ api_key, api_secret, client_key }`).
2. Redirect user to returned `auth_url`.
3. Kite redirects to `/api/zerodha/callback?request_token=...&state=...`.
4. Backend stores encrypted tokens, sets `zerodha_connected=true`, `broker=Zerodha`.
5. User redirected to frontend broker-connect page.

## PM2 / Workers

Ensure workers consume the Zerodha queue (already configured in `ecosystem.config.js`):

```bash
# API process
PROCESS_ROLE=api pm2 start ecosystem.config.js --only trustifyee-api

# Worker process (includes trade-execution-zerodha)
PROCESS_ROLE=workers pm2 start ecosystem.config.js --only trustifyee-workers
```

## Production Checklist

- [ ] Kite Connect app created; redirect URI whitelisted
- [ ] `ENCRYPTION_SECRET` set (32+ chars)
- [ ] Migration script executed
- [ ] Redis + MongoDB reachable from workers
- [ ] `trade-execution-zerodha` worker running
- [ ] TokenRefreshScheduler active (started in `index.ts`)
- [ ] Test OAuth connect → place order → copy trade signal
- [ ] Monitor `BrokerResponse` collection for audit trail
- [ ] Alert webhook configured for `ZERODHA_SESSION_EXPIRED` alerts

## Scaling (500+ Users)

| Component | Setting |
|-----------|---------|
| BullMQ concurrency | `TRADE_WORKER_CONCURRENCY` per worker |
| Token refresh | `TOKEN_REFRESH_CONCURRENCY=5` (default) |
| Rate limiting | Kite Connect: ~3 req/sec per API key — scale workers horizontally |
| Redis | Dedicated instance for BullMQ + redlock |
| Session validation | Runs every 15 min; expired users marked disconnected + admin alert |

## Security

- All tokens encrypted with AES-256-CBC (`enc::` prefix)
- Zerodha adapter isolated — no Angel/Upstox code paths modified
- Order execution rejects Admin documents (User-only)
- Session expiry triggers disconnect + `AlertService` notification

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `Token exchange failed` | Verify API key/secret match Kite app; check redirect URI |
| Copy trade skipped for Zerodha user | Ensure `broker=Zerodha`, `zerodha_connected=true`, subscription active |
| Orders fail with missing credentials | User must reconnect; check `zerodha_access_token` encrypted in DB |
| Session expired mid-day | User re-authenticates via Connect Broker; tokens expire daily at ~midnight IST |

## Rollback

Zerodha integration is additive. To disable without code rollback:

1. Set `BROKER_DISABLED=true` in SystemConfig (blocks all broker orders).
2. Remove Zerodha from user `broker` field in admin panel.
3. No Angel One or Upstox files need modification.
