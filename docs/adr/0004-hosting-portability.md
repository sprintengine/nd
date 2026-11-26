# 0004. Hosting: Docker images and env config, reference deployment on a VM behind Cloudflare

- Status: Accepted
- Date: 2026-11-26

## Context

The platform must run cheaply at pilot scale, stay movable between providers, and keep the OCPP WebSockets stable. myenergi's cloud holds one socket per charger for days, so anything that cuts idle or long-lived connections breaks charging control.

## Decision

- Each deployable is a **Docker image configured only through environment variables**. Postgres 17 + PostGIS is the only stateful dependency.
- **Reference deployment:** one Hetzner VM with Docker Compose (api, ocpp-gateway, Postgres, reverse proxy) behind **Cloudflare** for DNS, edge TLS and protection.
- The **OCPP hostname is DNS-only** (not proxied), so the WebSocket is not cut by edge idle timeouts or edge restarts; TLS for it ends on the VM. All other hostnames are proxied.
- **Alternative:** Cloudflare Containers for `api` and `ocpp-gateway` with an external managed Postgres that has PostGIS, provided the gateway runs as exactly one always-on instance.

## Consequences

- Moving between a VM, another container platform or a managed database is a configuration change, not a code change.
- The VM needs its own certificate management for the OCPP hostname, plus backups (nightly `pg_dump` to object storage) and OS patching.
- On the containers alternative, OCPP traffic goes through the edge, so reconnect handling, the 30 s pings and persist-before-ack are essential. Test them against the simulator before choosing it.
