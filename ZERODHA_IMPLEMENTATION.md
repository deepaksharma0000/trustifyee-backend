# Zerodha Kite Connect Integration

## Status: Production Ready

Zerodha is integrated as a fully isolated third broker alongside Angel One and Upstox. Angel One and Upstox code paths are unchanged.

## Folder Structure

```
trustifyee-backend/src/
├── adapters/
│   ├── IBrokerAdapter.ts
│   ├── BrokerAdapterRegistry.ts
│   ├── AngelOneAdapter.ts          # unchanged
│   ├── UpstoxAdapter.ts            # unchanged
│   └── ZerodhaAdapter.ts
├── controllers/
│   └── ZerodhaController.ts
├── routes/
│   └── zerodhaAuth.ts              # /api/zerodha/*
├── services/
│   ├── ZerodhaSessionService.ts
│   ├── OrderService.ts             # Zerodha branch via adapter
│   ├── SignalBroadcastService.ts   # ZERODHA in copy trading
│   └── TokenRefreshScheduler.ts    # Zerodha session validation
├── models/
│   └── User.ts                     # zerodha_* fields
├── jobs/
│   └── signalStatusSync.job.ts     # Angel + Zerodha order sync
├── utils/
│   └── tradeQueue.ts               # trade-execution-zerodha
├── scripts/
│   └── migrateZerodhaFields.ts
└── docs/
    └── ZERODHA_DEPLOYMENT.md
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/zerodha/connect` | Initiate OAuth |
| GET | `/api/zerodha/callback` | Kite redirect handler |
| POST | `/api/zerodha/refresh` | Validate session |
| POST | `/api/zerodha/disconnect` | Logout |
| GET | `/api/zerodha/profile` | Profile + status |
| GET | `/api/zerodha/status` | Connected / Disconnected / Expired |
| GET | `/api/zerodha/orders` | Orders |
| GET | `/api/zerodha/positions` | Positions |
| GET | `/api/zerodha/holdings` | Holdings |
| GET | `/api/zerodha/funds` | Margins |
| GET | `/api/zerodha/admin/status/:id` | Admin broker status |

Legacy: `GET /api/zerodha/auth/url`, `GET /api/zerodha/auth/callback`

## Copy Trading

`SignalBroadcastService` includes `ZERODHA` in supported brokers. Signals fan out to:

- `trade-execution-angelone`
- `trade-execution-upstox`
- `trade-execution-zerodha`

## Deployment

See [docs/ZERODHA_DEPLOYMENT.md](./docs/ZERODHA_DEPLOYMENT.md)

Migration:

```bash
npx ts-node src/scripts/migrateZerodhaFields.ts
```
