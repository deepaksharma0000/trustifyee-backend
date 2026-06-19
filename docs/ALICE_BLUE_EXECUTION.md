# Alice Blue Broker — Copy Trading Execution Guide

## Root causes fixed

| Issue | Fix |
|-------|-----|
| `SERVER_SIDE_EXECUTION_DISABLED` hard block | Controlled by `ALICE_ALLOW_SERVER_EXECUTION` (default: true) |
| Wrong API path `/orders/place` | Default now `/open-api/od/v1/orders/placeorder` |
| Wrong payload format (legacy) | ANT API v1 array payload with `instrumentId`, `transactionType`, etc. |
| No Alice session check at broadcast | Readiness validates `AliceTokens` + expiry |
| `client_key` not saved on OAuth | Callback now encrypts and saves `client_key` |
| Case-sensitive clientcode lookup | Normalized to uppercase |
| Order status sync excluded Alice | `signalStatusSync.job` includes `aliceblue` |
| Angel-only response parser in worker | Broker-specific `parseAliceOrderPlacement` |
| Missing contract master URLs | Defaults to Alice Blue static CDN URLs |
| Instrument sync required session | Public URLs — session optional |

## Required environment variables

```env
ALICE_CLIENT_ID=
ALICE_APP_CODE=
ALICE_API_SECRET=
ALICE_REDIRECT_URL=https://yourdomain.com/api/alice/auth/callback
ALICE_AUTH_BASE_URL=https://ant.aliceblueonline.com
ALICE_ORDER_BASE_URL=https://a3.aliceblueonline.com
ALICE_PLACE_ORDER_PATH=/open-api/od/v1/orders/placeorder
ALICE_ORDER_STATUS_PATH=/open-api/od/v1/orders/book
ALICE_GET_USER_DETAILS_PATH=/open-api/od/v1/vendor/getUserDetails
ALICE_ALLOW_SERVER_EXECUTION=true
ALICE_SESSION_TTL_HOURS=24
# Optional overrides:
# ALICE_CM_NFO_URL=
# ALICE_CM_NSE_URL=
# ALICE_CM_INDICES_URL=
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/alice/health/instruments` | Sync status, last sync, instrument count |
| POST | `/api/alice/validation/broadcast` | Admin preview — eligible/rejected Alice users |
| POST | `/api/alice/ins/instruments/sync` | Manual NFO sync (`force: true` to bypass interval) |
| GET | `/health` | Includes `aliceInstruments` block |

## One-time setup

```bash
# Sync Alice instruments (admin JWT required)
curl -X POST https://yourdomain.com/api/alice/ins/instruments/sync \
  -H "Authorization: Bearer ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"exchange":"NFO"}'

curl -X POST ... -d '{"exchange":"NSE"}'
```

## User connection flow

1. User opens Profile → Broker Connect → Alice Blue
2. Enters client code → OAuth redirect
3. Callback saves session + `client_key` + `broker_connected`
4. User must match admin strategy subscription

## Admin copy-trade flow

1. Admin POST `/api/orders/place-all` or broadcast signal
2. `SignalBroadcastService` filters Alice Blue users
3. Readiness checks Alice session
4. `TradeOutbox` → `trade-execution-aliceblue` queue
5. `TradeExecutionWorker` → `OrderService` → `AliceOrderService`
6. `AliceBlueAdapter.placeOrder` → Alice ANT API
7. Status stored in `SignalExecutionResult` + `BrokerResponse`
8. WebSocket `TRADE_EXECUTION_UPDATE` to user

## Paper vs live

- Non-production `NODE_ENV` → paper simulator for all brokers
- Production + user `licence=live` → real Alice orders (when session valid)

## Validation checklist

- [ ] User connected Alice Blue (OAuth)
- [ ] `AliceTokens` has session for user
- [ ] NFO instruments synced
- [ ] `ALICE_ALLOW_SERVER_EXECUTION=true`
- [ ] VPS IP whitelisted on Alice Blue app (if required)
- [ ] Admin strategy broadcast shows Alice users READY
