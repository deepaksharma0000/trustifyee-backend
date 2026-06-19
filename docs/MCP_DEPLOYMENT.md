# Trustifyee MCP (Model Context Protocol) Deployment Guide

## Important: Alice vs MCP

| Term | What it is in Trustifyee |
|------|--------------------------|
| **Alice Blue** | Indian stock broker (ANT API). Already integrated at `/api/alice/*`. |
| **Alice AI** | Not implemented. No Alice AI product integration exists. |
| **MCP** | Model Context Protocol — AI assistant integration at `/mcp`. **New in this release.** |
| **Execution Agent** | WebSocket client for decentralized Angel One order execution (`uploads/agent/`). Not MCP. |

---

## Architecture

```
┌─────────────────┐     Streamable HTTP      ┌──────────────────────────┐
│  AI Client      │ ───────────────────────► │  Trustifyee Backend      │
│  (Cursor,       │   POST /mcp              │  Express + MCP Server      │
│   Claude, etc.) │   X-MCP-API-Key          │  ├─ Tools (read-only)    │
└─────────────────┘   X-User-Token (JWT)     │  ├─ Resources            │
                                              │  └─ Prompts              │
┌─────────────────┐     stdio (local)        └───────────┬──────────────┘
│  Claude Desktop │ ───────────────────────►             │
│  Cursor MCP     │   npm run mcp:stdio                  │
└─────────────────┘                                      ▼
                                              ┌──────────────────────────┐
                                              │  MongoDB, Redis, Brokers   │
                                              └──────────────────────────┘
```

---

## Environment Variables

Add to `.env`:

```env
# MCP — Model Context Protocol (AI assistant integration)
MCP_ENABLED=true
MCP_API_KEY=your-secure-random-key-min-32-chars
MCP_AUTH_MODE=both
MCP_SERVER_NAME=trustifyee-mcp
MCP_SERVER_VERSION=1.0.0
MCP_BASE_PATH=/mcp
MCP_ENABLE_TRADE_TOOLS=false
MCP_RATE_LIMIT_WINDOW_MS=60000
MCP_RATE_LIMIT_MAX=120
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_ENABLED` | No | `true` | Set `false` to disable MCP endpoints |
| `MCP_API_KEY` | **Yes (prod)** | — | Server API key (min 32 chars) |
| `MCP_AUTH_MODE` | No | `both` | `api_key`, `jwt`, or `both` |
| `MCP_ENABLE_TRADE_TOOLS` | No | `false` | Trade tools stay read-only by design |
| `MCP_RATE_LIMIT_MAX` | No | `120` | Max requests per window per IP |

Generate API key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Server Setup (VPS)

### 1. Prerequisites

- Node.js 20 LTS
- MongoDB 7, Redis 7
- Nginx reverse proxy
- PM2 process manager

### 2. Build and start

```bash
cd trustifyee-backend
npm ci
npm run build
pm2 start ecosystem.config.js --env production
pm2 save
```

MCP runs inside the main API process (`trustifyee-api`). No separate service required.

### 3. Nginx

Copy `deployment/nginx-trustifyee.conf` and ensure `/mcp` location is included. Reload:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 4. Verify

```bash
curl http://127.0.0.1:5000/mcp/info
curl -H "X-MCP-API-Key: YOUR_KEY" http://127.0.0.1:5000/mcp/info
```

---

## Docker Deployment

```bash
cd trustifyee-backend
# Ensure MCP_* vars are in .env
docker compose up -d --build
docker compose logs -f backend
curl http://127.0.0.1:5000/mcp/info
```

MCP shares the backend container. Expose via Nginx only — do not publish port 5000 publicly without auth.

---

## PM2 Commands

```bash
pm2 start ecosystem.config.js --env production
pm2 restart trustifyee-api
pm2 logs trustifyee-api --lines 100
pm2 monit
```

---

## Cursor / Claude Desktop Configuration

### Remote HTTP (production)

In Cursor MCP settings:

```json
{
  "mcpServers": {
    "trustifyee": {
      "url": "https://api.yourdomain.com/mcp",
      "headers": {
        "X-MCP-API-Key": "YOUR_MCP_API_KEY",
        "X-User-Token": "YOUR_USER_JWT"
      }
    }
  }
}
```

### Local stdio (development)

```json
{
  "mcpServers": {
    "trustifyee-local": {
      "command": "node",
      "args": ["dist/mcp/standalone.js"],
      "cwd": "/path/to/trustifyee-backend",
      "env": {
        "MONGO_URI": "mongodb://localhost:27017/trustifyee",
        "ENCRYPTION_SECRET": "your-32-char-secret",
        "MCP_ENABLED": "true"
      }
    }
  }
}
```

Build first: `npm run build && npm run mcp:stdio`

---

## MCP Tools Reference

| Tool | Auth | Description |
|------|------|-------------|
| `get_system_health` | API key | Mongo, Redis, OMS metrics |
| `get_market_status` | API key | NSE open/closed (IST) |
| `get_observability_metrics` | API key | Alerts and metrics |
| `list_supported_brokers` | API key | Angel, Alice Blue, Upstox, Zerodha |
| `get_user_profile` | User JWT | User account info |
| `get_broker_connection_status` | User JWT | Broker link status |
| `get_open_positions` | User JWT | Open positions (max 50) |
| `get_active_signals` | User JWT | Pending signals |

---

## Testing Steps

1. **Build**: `npm run build`
2. **Info endpoint**: `curl localhost:4000/mcp/info`
3. **Auth rejection**: `curl -X POST localhost:4000/mcp -d '{}'` → 401
4. **Health tool**: Use MCP Inspector or Cursor to call `get_system_health`
5. **User tools**: Pass valid `X-User-Token` JWT from login
6. **Rate limit**: Exceed `MCP_RATE_LIMIT_MAX` → 429

---

## Security Notes

- MCP is **read-only** for trading by default
- Never commit `MCP_API_KEY` to git
- Use separate API keys per environment
- Bind backend to `127.0.0.1` behind Nginx
- User-scoped tools require JWT — API key alone is insufficient for positions/signals

---

## API Documentation

- MCP discovery: `GET /mcp/info`
- Health: `GET /health`
- Observability: `GET /api/observability/metrics`
- Prometheus: `GET /api/observability/prometheus`
