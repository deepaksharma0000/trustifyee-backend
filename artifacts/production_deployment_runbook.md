# Pandit Algo Trading System: Production Deployment & Hardening Runbook

This runbook defines the operational standards and step-by-step procedures for deploying and maintaining the **Pandit Algo Trading System** in production under the April 1, 2026 SEBI/NSE Retail Algo Framework.

---

## 1. Architectural & Provisioning Specifications

### 1.1 Outbound Network Topology
Under the smartAPI static IP framework, all broker requests must route through whitelisted, static IPv4 addresses.
```
  +-----------------------------------------------------------+
  |                   Centralized VPS (Static IP)             |
  |  +------------------+  +-----------------+  +----------+  |
  |  |  trustifyee OMS  |  |  TickEngine/WS  |  |  Redis   |  |
  |  +--------+---------+  +--------+--------+  +----+-----+  |
  +-----------|---------------------|----------------|--------+
              | (Shared Outbound IP)| (IP Tunnels)   | (Private Net)
              v                     v                v
      [ Broker APIs ]       [ Exchange Feed ]  [ Replica DB ]
```
- **Execution Target**: Centralized high-performance VPS (Ubuntu 22.04 LTS / 24.04 LTS).
- **Outbound Static IP**: Shared static IP assigned to the primary interface (`eth0`) or dedicated routing tunnels mapping client segments to isolated outbound exit ports.

### 1.2 Resource Allocation Guidelines
- **CPU**: 4 Cores Minimum (Intel Xeon / AMD EPYC optimized for low jitter).
- **RAM**: 8 GB ECC RAM (to accommodate write-ahead event streams and in-memory cache).
- **Storage**: 80 GB NVMe SSD (high IOPS for event-sourcing append operations).

---

## 2. PM2 Cluster & Process Orchestration

To guarantee zero-downtime upgrades and immediate recovery from unexpected process crashes, the system is orchestrated in cluster mode.

### 2.1 PM2 Configuration File (`ecosystem.config.js`)
Create this file in the project root:
```javascript
module.exports = {
  apps: [
    {
      name: "pandit-backend-oms",
      script: "./dist/index.js",
      instances: "2", // Low cluster concurrency to stay within connection rate bounds
      exec_mode: "cluster",
      watch: false,
      max_memory_restart: "2G",
      env_production: {
        NODE_ENV: "production",
        PORT: 4000,
        MONGO_URI: "mongodb://admin:STRONG_DB_PASS@127.0.0.1:27017/pandit_prod?authSource=admin",
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: 6379,
        ENABLE_LIVE_TOKEN_REPAIR: "true",
        CLOCK_DRIFT_THRESHOLD_MS: "80"
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      merge_logs: true,
      autorestart: true,
      exp_backoff_restart_delay: 100
    }
  ]
};
```

### 2.2 Operational PM2 Commands
```bash
# Start cluster in production mode
pm2 start ecosystem.config.js --env production

# Graceful reload (zero-downtime hot reload)
pm2 reload pandit-backend-oms

# Monitor process metrics in real-time
pm2 monit

# Save PM2 state to restore on system reboot
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u admin --hp /home/admin
```

---

## 3. Nginx Reverse Proxy & SSL (TLS 1.3) Hardening

Nginx intercepts incoming client request traffic, terminates SSL/TLS using secure v1.3 protocols, whitelists origins, and handles WebSocket connection upgrades for the live TickEngine feeds.

### 3.1 Nginx Server Block Configuration (`/etc/nginx/sites-available/pandit-algo`)
```nginx
# Rate limiting zones
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;

server {
    listen 80;
    server_name api.panditalgo.com;
    return 301 https://$host$request_uri; # Force SSL redirect
}

server {
    listen 443 ssl http2;
    server_name api.panditalgo.com;

    # SSL Certificates
    ssl_certificate /etc/letsencrypt/live/api.panditalgo.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.panditalgo.com/privkey.pem;

    # TLS 1.3 Only & Cipher Hardening
    ssl_protocols TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_conf_command Options PrioritizeChaCha;
    ssl_ciphers 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256';

    # Session configuration
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # Hardened Security Headers
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none';" always;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

    # Logging
    access_log /var/log/nginx/pandit-access.log;
    error_log /var/log/nginx/pandit-error.log warn;

    # Proxy Headers
    location / {
        limit_req zone=api_limit burst=20 nodelay;
        proxy_pass http://127.0.0.1:4000;
        
        # Proxy Headers
        proxy_http_version 1.1;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Host $http_host;
        
        # CORS Policies
        proxy_hide_header Access-Control-Allow-Origin;
        add_header Access-Control-Allow-Origin "https://dashboard.panditalgo.com" always;
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Content-Type, Authorization" always;
    }

    # WebSocket Upgrade endpoint for TickEngine Stream
    location /socket.io {
        proxy_pass http://127.0.0.1:4000;
        
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Host $http_host;
        
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

---

## 4. Database Persistence & Automated Backups

To ensure that the transactional, write-ahead event-sourcing OMS (`OMSEventModel`) is replay-safe, we enforce strict storage and recovery standards.

### 4.1 Redis Persistence Policies
Configure `/etc/redis/redis.conf` to guarantee high availability and transaction tracking:
```ini
# Enforce both AOF (Append-Only File) and RDB snapshotting
appendonly yes
appendfsync everysec
no-appendfsync-on-rewrite no

# RDB Snapshots as failover backups
save 900 1
save 300 10
save 60 10000

# Max memory cap to prevent virtual memory paging swap
maxmemory 2gb
maxmemory-policy volatile-lru
```

### 4.2 MongoDB Automated Backup Script (`/var/scripts/mongo-backup.sh`)
```bash
#!/bin/bash
BACKUP_DIR="/var/backups/mongodb"
DATE=$(date +%Y-%m-%d_%H%M%S)
RETENTION_DAYS=7

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Execute mongodump
mongodump --uri="mongodb://admin:STRONG_DB_PASS@127.0.0.1:27017/pandit_prod?authSource=admin" --out="$BACKUP_DIR/$DATE" --gzip

# Compress the dump
tar -czf "$BACKUP_DIR/backup-$DATE.tar.gz" -C "$BACKUP_DIR" "$DATE"
rm -rf "$BACKUP_DIR/$DATE"

# Purge backups older than retention limits
find "$BACKUP_DIR" -name "backup-*.tar.gz" -mtime +$RETENTION_DAYS -exec rm {} \;

log "MongoDB backup successfully written and archived."
```
Register the script in CRON to run daily at midnight:
```bash
0 0 * * * /bin/bash /var/scripts/mongo-backup.sh >> /var/log/mongo-backup.log 2>&1
```

---

## 5. Security & Firewall (UFW) Policies

Default Deny policies prevent unauthorized remote access to databases and inter-process socket bridges.

```bash
# Default policies
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow standard web entry
sudo ufw allow 80/tcp comment 'HTTP Redirect'
sudo ufw allow 443/tcp comment 'HTTPS Secure Traffic'
sudo ufw allow 22/tcp comment 'SSH Secure Administration'

# Block external access to MongoDB and Redis ports
sudo ufw deny 27017/tcp comment 'Block External MongoDB'
sudo ufw deny 6379/tcp comment 'Block External Redis'

# Enable firewall
sudo ufw enable
```

---

## 6. Telemetry & Observability Thresholds

Use Prometheus to scrape the scraping endpoint `/api/observability/prometheus` at a high-fidelity interval of `5s` during trading hours (9:15 AM to 3:30 PM).

### 6.1 Recommended Alerting Rules
- **OMS Jitter Alert**: Trigger `CRITICAL` alert if `avgOmsLatencyMs` > 300ms for more than 3 consecutive scrapes.
- **State Reconciliation Fail**: Trigger `CRITICAL` alert immediately if `reconMismatchesCount` > 0.
- **WebSocket Feed Degraded**: Trigger `WARNING` if `tickThroughput` flatlines (rate change is 0 over a 15-second window).
- **Execution Rate Throttle**: Trigger `WARNING` if the global rate limiter rejects > 5% of outbound client requests over a 1-minute window.

---

## 7. Rollback & Disaster Recovery Strategies

If a deployment contains bugs or the system experiences runtime degraded performance, proceed with this sequential recovery roadmap:

### 7.1 Automated Safe-Mode Transition
1. In the event of persistent MongoDB connection timeout or Redis pool exhaustion, the system automatically transitions all users to `SAFE_MODE`.
2. Entry orders are suspended.
3. Users are allowed to submit exit orders or trigger emergency portfolio liquidations only.

### 7.2 Zero-Downtime Hot Code Rollback
If code changes cause OMS execution latency spikes:
```bash
# 1. Rollback code repository to last stable release commit
git checkout <last_stable_tag>
npm install
npm run build

# 2. Sequential reloading of cluster instances (Zero downtime)
pm2 reload pandit-backend-oms --hot

# 3. Verify logs for stable startup diagnostics
pm2 logs pandit-backend-oms
```

### 7.3 Transactional Replay OMS State Recovery
If the server crashes mid-trade:
1. Re-launch the PM2 process.
2. The OMS boot sequence initializes `recoverStateFromDb()` automatically.
3. The engine chronologically fetches the sequential event logs from `OMSEventModel` corresponding to today's date.
4. By sequentially replaying `INTENT_LOGGED`, `CREATED`, and `COMPLETED` events, the memory structure reconstructs the active position state exactly as it was prior to the crash, ensuring zero data loss and perfect broker state synchronization.
