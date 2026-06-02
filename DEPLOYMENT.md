# 🚀 Trustifyee Trading Backend — Production Deployment Guide

## 1. Prerequisites Checklist

Before deploying, complete ALL items:

### Angel One Portal (MANDATORY — NO CODE CAN BYPASS THIS)
- [ ] Login to https://smartapi.angelone.in
- [ ] Find the app with API key ending in `...jrsI` (your `ANGEL_API_KEY`)
- [ ] In that app's settings → **Whitelist IP**: Add `147.93.18.15` (your VPS IP)
- [ ] Save changes
- [ ] **All user trades will fail with "API key mismatch against app found with static IP" until this is done**

### VPS/Server Setup
- [ ] Node.js 20 LTS installed
- [ ] Redis 7 running (`redis-cli ping` returns PONG)
- [ ] MongoDB 7 running
- [ ] PM2 installed globally (`npm install -g pm2`)
- [ ] Nginx installed and configured

---

## 2. Environment Configuration

Ensure these critical values are set in `.env`:

```bash
# REQUIRED: Must match the IP whitelisted in Angel One portal
PUBLIC_IP=147.93.18.15
ANGEL_CLIENT_PUBLIC_IP=147.93.18.15

# REQUIRED: Platform key mode (all users share this Angel app key)
USE_PLATFORM_ANGEL_API_KEY=true
ANGEL_API_KEY=7ieSjsrI

# REQUIRED: Shared VPS mode
FORCE_SHARED_VPS_ROUTE=true
EXECUTION_MODE=SERVER_SHARED_IP

# REQUIRED: Angel One local binding disabled (VPS shared IP)
ANGEL_ENABLE_LOCAL_BINDING=false
```

---

## 3. Build & Deploy

```bash
# 1. Install dependencies
npm ci

# 2. Build TypeScript
npm run build

# 3. Start with PM2
pm2 start ecosystem.config.js --env production

# 4. Save PM2 process list
pm2 save

# 5. Enable PM2 auto-start on system reboot
pm2 startup
# (run the command PM2 outputs)

# 6. Monitor logs
pm2 logs trustifyee-backend --lines 50
pm2 monit
```

---

## 4. Health Verification

```bash
# Check server health
curl http://localhost:5000/health | python3 -m json.tool

# Verify the IP whitelist configuration is logged on startup
pm2 logs trustifyee-backend | grep "IP whitelist status"

# Check Redis connectivity
redis-cli ping

# Check MongoDB connectivity
mongosh --eval "db.adminCommand('ping')"
```

Expected health response:
```json
{
  "status": "ok",
  "mongo": "connected",
  "redis": "ready",
  "executionMode": "SERVER_SHARED_IP"
}
```

---

## 5. What Was Fixed

### Fix 1: tradeQueue.ts — Log import order bug
- `log` was imported at line 123 but used at line 41 in `setStartupCorrelationId()`
- This caused silent runtime failures when the queue startup log was called
- **Fixed**: Moved import to line 1

### Fix 2: OutboxService.ts — Duplicate jobId causing silent retry drops
- BullMQ `queue.add()` with a duplicate `jobId` is a no-op (silent deduplication)
- When an outbox item was retried, the old jobId still existed in Redis → retry dropped
- **Fixed**: jobId now includes attempt counter: `outbox-${id}-a${attempts}`

### Fix 3: AngelSessionContextService.ts — Stale JWT delivered from 10s cache
- After token refresh, the execution path could still serve an expired JWT from cache
- This caused intermittent `AG8001 Invalid Token` at the broker
- **Fixed**: Execution path bypasses cache entirely, always fetches fresh from MongoDB

### Fix 4: TokenRefreshScheduler.ts — Refreshing inactive/disconnected users
- All sessions were refreshed regardless of user status, causing Angel One rate limits
- `AB1008 Maximum attempts exceeded` lockout was triggered by unnecessary logins
- **Fixed**: Now filters to only `active + broker_connected + trading_status=enabled` users
- **Fixed**: Added p-limit(5) concurrency to prevent login storms

### Fix 5: OrderService.ts — Admin session leakage
- If userId didn't match a User, code fell back to Admin collection silently
- Admin broker credentials could be used for user trades (isolation violation)
- **Fixed**: Removed Admin fallback entirely. All trades must be from verified User records.

### Fix 6: AngelSessionLifecycleService.ts — broker_connected cleared on ANY error
- A single network timeout during login set `broker_connected=false` permanently
- Users couldn't receive signals until they manually reconnected
- **Fixed**: `classifyErrorPermanence()` now distinguishes permanent (AB1008, AG8004, wrong MPIN)
  from transient (network timeout, 5xx, rate limit) errors
- Only permanent errors clear `broker_connected`

### Fix 7: BrokerHealthDiagnostics.ts — New utility
- Pre-trade health checks with actionable error messages
- IP whitelist action plan logged at startup
- Can be called from monitoring endpoints

### Fix 8: PM2 Ecosystem Config
- Fork mode (not cluster) — BullMQ workers cannot be duplicated
- Graceful shutdown with 15s kill timeout for in-flight trades
- Daily cron restart at 3:30 AM IST (before 9:15 AM market open)
- Exponential backoff restart delay prevents login storm during crash loops

---

## 6. Post-Deployment Monitoring

```bash
# Watch live execution logs
pm2 logs trustifyee-backend | grep -E "BROKER_EXECUTION_CONTEXT|PLACE_ORDER|ORDER_REJECTED|AG8001|AG8004|AB1008"

# Check for IP whitelist errors
pm2 logs trustifyee-backend | grep -i "static ip\|unregistered ip\|api key mismatch"

# Check queue health
curl http://localhost:5000/api/observability/queues

# Check session health
curl http://localhost:5000/health | python3 -m json.tool
```

---

## 7. Common Issues & Solutions

| Error | Cause | Solution |
|-------|-------|----------|
| `API key mismatch against app found with static IP` | VPS IP not whitelisted | Go to Angel One SmartAPI portal → whitelist `147.93.18.15` |
| `AG8001 Invalid Token` | JWT expired, session stale | Token refresh scheduler will fix automatically within 15 min. Check `broker_connected` status |
| `AB1008 Maximum attempts exceeded` | Too many login attempts | Wait 24h for Angel One to lift lockout. Check `TokenRefreshScheduler` isn't retrying inactive users |
| `USER_NOT_FOUND` | Admin tried to execute trade | Check signal is targeted to Users, not Admins |
| `BROKER_SESSION_CLIENT_MISMATCH` | JWT belongs to different clientcode | User must reconnect broker from profile settings |
| `CIRCUIT_BREAKER_OPEN` | Multiple consecutive failures | Check broker status, then manually reset: `CircuitBreakerService.reset(broker, "ORDER")` |
