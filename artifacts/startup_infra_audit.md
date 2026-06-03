# Institutional-Grade Infrastructure Hardening & Startup Diagnostics Audit
**Startup Correlation ID:** `STARTUP-CID-A0E8902D68205F40`  
**Audit Execution Time:** `2026-06-03T12:09:12.004Z`  
**System Current State:** `FAILED`  
**Safe Boot Mode Active:** `NO`  
**Integrity Signature (SHA256):** `5d43711d96c53c5de2b5c635d3da581e056270a29bf1a604b5e46162d5079dc9`

---

## 1. Startup Volatility & Drift Analytics
* **Startup Volatility (Latency Jitter StdDev):** `15791.94 ms`
* **Average MongoDB RTT:** `85.16 ms`
* **Average Redis RTT:** `11.61 ms`
* **Warmup Phase Duration:** `41479 ms`

---

## 2. Infrastructure Health & Metrics Heatmap
* **Most Unstable Dependency:** `MONGO`
* **Average Reconnect Attempts:** `1.8 attempts`
* **Degraded Subsystem Frequencies:**
  - No degraded subsystems detected.

---

## 3. Detailed Component Diagnostics Registry

| Subsystem | Status | Latency / Metric | Sequencing Order | Error Details |
| :--- | :--- | :--- | :--- | :--- |
| **System Timezone** | `DEGRADED` | Timezone: `Asia/Calcutta` | `1` | `Timezone drift check failed. Host timezone set to: Asia/Calcutta. Expected: Asia/Kolkata` |
| **Disk Writability** | `VERIFIED` | Latency: `8ms` | `2` | `None` |
| **Redis Server** | `REACHABLE` | Redis RTT: `62ms` | `3` | `None` |
| **BullMQ Engine** | `DEGRADED` | Redis Version: `5.0.14.1` | `4` | `Redis version 5.0.14.1 detected. BullMQ requires Redis >= 6.2 for streams. Fallbacks activated.` |
| **MongoDB Connection** | `FAILED` | Mongo RTT: `-1ms` | `5` | `MongoConnectionAttempt_1_Failed (took 5057ms): connect ECONNREFUSED 127.0.0.1:27017; MongoConnectionAttempt_2_Failed (took 5016ms): connect ECONNREFUSED 127.0.0.1:27017; MongoConnectionAttempt_3_Failed (took 5028ms): connect ECONNREFUSED 127.0.0.1:27017; MongoConnectionAttempt_4_Failed (took 5011ms): connect ECONNREFUSED 127.0.0.1:27017; MongoConnectionAttempt_5_Failed (took 5017ms): connect ECONNREFUSED 127.0.0.1:27017 (Attempts: 5)` |
| **WebSocket Server** | `READY` | Verified | `6` | `None` |
| **Order Management** | `FAILED` | Verified | `7` | `OMS check failed: dependent MongoDB infrastructure is failed.` |

---

## 4. Hardened Startup Workflow & Graceful Failures
1. **Infra Verification Blocks:** If critical resources (Mongo/Disk/Keys) fail, the app aborts early, emitting diagnostics and exiting with status code `1`.
2. **Graceful Pipeline Stoppage:** Pre-empts partial boot crashes by isolating express execution and WS startup until infra check confirmation is attained.
3. **Audit History Logged:** Every boot produces a clean markdown artifact in the `artifacts/` space for instant SRE inspection.
