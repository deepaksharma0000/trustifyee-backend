# Institutional-Grade Infrastructure Hardening & Startup Diagnostics Audit
**Startup Correlation ID:** `STARTUP-CID-1117D97EFFA862D7`  
**Audit Execution Time:** `2026-05-18T13:02:00.767Z`  
**System Current State:** `FAILED`  
**Safe Boot Mode Active:** `NO`  
**Integrity Signature (SHA256):** `b2b9f97538bb786f98dbbc06bb43ea3f04dbfa5d2c36b8e5b6831977bfc6987f`

---

## 1. Startup Volatility & Drift Analytics
* **Startup Volatility (Latency Jitter StdDev):** `19309.85 ms`
* **Average MongoDB RTT:** `49.22 ms`
* **Average Redis RTT:** `6.56 ms`
* **Warmup Phase Duration:** `40888 ms`

---

## 2. Infrastructure Health & Metrics Heatmap
* **Most Unstable Dependency:** `MONGO`
* **Average Reconnect Attempts:** `2.67 attempts`
* **Degraded Subsystem Frequencies:**
  - No degraded subsystems detected.

---

## 3. Detailed Component Diagnostics Registry

| Subsystem | Status | Latency / Metric | Sequencing Order | Error Details |
| :--- | :--- | :--- | :--- | :--- |
| **System Timezone** | `DEGRADED` | Timezone: `Asia/Calcutta` | `1` | `Timezone drift check failed. Host timezone set to: Asia/Calcutta. Expected: Asia/Kolkata` |
| **Disk Writability** | `VERIFIED` | Latency: `5ms` | `2` | `None` |
| **Redis Server** | `REACHABLE` | Redis RTT: `8ms` | `3` | `None` |
| **BullMQ Engine** | `DEGRADED` | Redis Version: `5.0.14.1` | `4` | `Redis version 5.0.14.1 detected. BullMQ requires Redis >= 6.2 for streams. Fallbacks activated.` |
| **MongoDB Connection** | `FAILED` | Mongo RTT: `-1ms` | `5` | `MongoConnectionAttempt_1_Failed (took 5037ms): connect ECONNREFUSED 127.0.0.1:27017; MongoConnectionAttempt_2_Failed (took 5019ms): connect ECONNREFUSED 127.0.0.1:27017; MongoConnectionAttempt_3_Failed (took 5017ms): connect ECONNREFUSED 127.0.0.1:27017; MongoConnectionAttempt_4_Failed (took 5019ms): connect ECONNREFUSED 127.0.0.1:27017; MongoConnectionAttempt_5_Failed (took 5015ms): connect ECONNREFUSED 127.0.0.1:27017 (Attempts: 5)` |
| **WebSocket Server** | `READY` | Verified | `6` | `None` |
| **Order Management** | `FAILED` | Verified | `7` | `OMS check failed: dependent MongoDB infrastructure is failed.` |

---

## 4. Hardened Startup Workflow & Graceful Failures
1. **Infra Verification Blocks:** If critical resources (Mongo/Disk/Keys) fail, the app aborts early, emitting diagnostics and exiting with status code `1`.
2. **Graceful Pipeline Stoppage:** Pre-empts partial boot crashes by isolating express execution and WS startup until infra check confirmation is attained.
3. **Audit History Logged:** Every boot produces a clean markdown artifact in the `artifacts/` space for instant SRE inspection.
