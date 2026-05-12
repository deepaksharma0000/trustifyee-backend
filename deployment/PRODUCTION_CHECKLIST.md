# Production Checklist

1. Use Node 20+ and Redis 6.2+.
2. Set system timezone and clock sync:
   - `timedatectl set-timezone Asia/Kolkata`
   - `timedatectl set-ntp true`
3. Build before PM2 start:
   - `npm ci`
   - `npm run build`
   - `pm2 start deployment/pm2.ecosystem.config.cjs`
4. Ensure Redis connection env is correct (`REDIS_URL` or `REDIS_HOST` + `REDIS_PORT`).
5. Ensure websocket paths are proxied in Nginx:
   - `/ws/signals`
   - `/ws/market`
6. Keep `ENCRYPTION_SECRET`, JWT secrets, and broker keys identical across restarts.
7. Verify post-deploy:
   - `GET /health`
   - Admin login
   - User broker connect
   - `/api/orders/place-all` -> check `SignalExecutionResult`, `TradeOutbox`, and queue worker logs.
8. Rotate PM2 logs and keep at least 7 days retention.
