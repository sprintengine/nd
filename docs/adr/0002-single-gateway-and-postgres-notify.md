# 0002. Two deployables, a single OCPP gateway, Postgres NOTIFY

- Status: Accepted
- Date: 2026-11-26

## Context

Chargers hold long-lived WebSockets to the gateway, and the API needs to send them commands and hear their events. A separate message broker and worker fleet would add services to run before the platform has enough chargers to need them.

## Decision

- Run **two processes**: `api` (HTTP, realtime, pg-boss jobs) and `ocpp-gateway`. No Redis and no separate worker.
- Run **one gateway instance**, which keeps the socket map in memory, keyed by ChargeboxID.
- **Gateway to API:** the gateway writes each message to Postgres first, then sends `NOTIFY charger_events` with ids only. The API `LISTEN`s and reads the rows, and catches up from the tables after any reconnect, because NOTIFY is not durable.
- **API to gateway:** an internal HTTP endpoint implementing `ChargerControl`, protected by a shared secret and reachable only on the private network.
- The gateway sends a WebSocket ping to every charger every 30 s.

## Consequences

- Fewer moving parts: one database carries the data, the jobs and the events.
- The gateway is a single point of failure for live commands. A restart drops in-flight commands, which the API retries, and myenergi reconnects; persisted data is not lost.
- Scaling past one gateway, expected only at several thousand chargers, needs a shared socket registry and routing of commands to the instance that owns the socket. `ChargerControl` is the seam where that goes.
