# Production Checklist

1. Use Node 20+ and Redis 6.2+.
2. Set system timezone and clock sync:
   - `timedatectl set-timezone Asia/Kolkata`
   - `timedatectl set-ntp true`
3. Build before PM2 start:
   - `npm ci`
   - `npm run build`
   - `pm2 start deployment/pm2.ecosystem.config.cjs --update-env`
4. Ensure Redis connection env is correct (`REDIS_URL` or `REDIS_HOST` + `REDIS_PORT`).
5. Ensure websocket paths are proxied in Nginx:
   - `/ws/signals`
   - `/ws/market`
6. Keep `ENCRYPTION_SECRET`, JWT secrets, and broker keys identical across restarts.
7. Ensure shared VPS routing is enabled for all users:
   - `FORCE_SHARED_VPS_ROUTE=true`
   - `PUBLIC_IP=<YOUR_VPS_STATIC_IPV4>`
   - `ANGEL_CLIENT_PUBLIC_IP=<YOUR_VPS_STATIC_IPV4>` (optional override; defaults to `PUBLIC_IP`)
   - `ANGEL_CLIENT_LOCAL_IP=<YOUR_VPS_LOCAL_IPV4>` (optional override)
   - `ANGEL_CLIENT_MAC_ADDRESS=<YOUR_SERVER_NIC_MAC>` (optional override)
   - `ANGEL_SOURCE_ID=WEB`
   - `ANGEL_USER_TYPE=USER`
   - `ANGEL_REFRESH_TOKENS_PATH=/rest/auth/angelbroking/jwt/v1/generateTokens`
   - `ANGEL_ENABLE_LOCAL_BINDING=false`
   - `ALLOW_GLOBAL_ANGEL_API_KEY_FALLBACK=false`
   - `ALLOW_GLOBAL_SESSION_FALLBACK=false`
   - `ENABLE_LIVE_TOKEN_REPAIR=false`
8. Verify post-deploy:
   - `GET /health`
   - Admin login
   - User broker connect
   - `/api/orders/place-all` -> check `SignalExecutionResult`, `TradeOutbox`, and queue worker logs.
9. Rotate PM2 logs and keep at least 7 days retention.
