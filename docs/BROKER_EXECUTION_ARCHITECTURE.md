# Broker Execution Architecture (Angel One)

## Problem summary

Admin strategy trades succeeded while user copies failed because execution could resolve **another user's JWT** (global session fallback), **shared SmartAPI adapters** keyed only by API key, and **clientcode-only** token lookups.

## Target architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────────────┐
│ Strategy / Algo │────▶│ SignalService        │────▶│ WebSocket TRADE_SIGNAL  │
│ (signals only)  │     │ (no broker I/O)      │     │ (notify clients)        │
└────────┬────────┘     └──────────────────────┘     └─────────────────────────┘
         │
         ▼
┌─────────────────────────┐     ┌──────────────────────────┐
│ SignalBroadcastService  │────▶│ TradeOutbox (Mongo)      │
│ (fan-out per user)      │     └────────────┬─────────────┘
└─────────────────────────┘                  │
                                               ▼
                              ┌──────────────────────────────┐
                              │ BullMQ trade-execution-*     │
                              └──────────────┬───────────────┘
                                             ▼
                              ┌──────────────────────────────┐
                              │ TradeExecutionWorker         │
                              └──────────────┬───────────────┘
                                             ▼
                              ┌──────────────────────────────┐
                              │ TradeExecutionService        │
                              │ (isolation + audit logs)     │
                              └──────────────┬───────────────┘
                                             ▼
                              ┌──────────────────────────────┐
                              │ AngelUserSessionManager      │
                              │ userId + clientcode + tokens │
                              └──────────────┬───────────────┘
                                             ▼
                              ┌──────────────────────────────┐
                              │ getOrCreateUserAngelAdapter  │
                              │ (per-user adapter cache)     │
                              └──────────────────────────────┘
```

## Isolation rules

| Layer | Key | Never |
|-------|-----|-------|
| Adapter cache | `userId \| apiKey \| ip \| agent` | Share across users |
| Session DB lookup (orders) | `userId + clientcode` | Global fallback |
| SessionAuthority | `userId \| clientCode` | clientCode alone |
| Execution queue job | `userId`, `clientCode` in payload | Reuse admin JWT |

## Required environment

```env
ALLOW_GLOBAL_SESSION_FALLBACK=false
ALLOW_GLOBAL_ANGEL_API_KEY_FALLBACK=false
ANGEL_PROACTIVE_REFRESH_MS=1800000
```

## Scaling recommendations

1. Run **API** and **workers** as separate processes (same Redis).
2. Set worker `concurrency` per VPS egress capacity (Angel rate limits).
3. Use **dedicated_ip_enabled** per user when Angel app is bound to static IP.
4. Horizontally scale workers; keep Mongo `AngelTokens` as source of truth.
5. For multi-node WebSocket signals, add Redis pub/sub fan-out (in-memory `UserSocketService` is single-node).

## Operations checklist

- [ ] Each user has own SmartAPI app key in profile + `AngelTokens` row for their `userId`
- [ ] Server egress IP whitelisted on **each** user's Angel app
- [ ] `broker_connected` / JWT refresh scheduler running
- [ ] Monitor BullMQ failed jobs + `[EXECUTION] FAILED` logs
