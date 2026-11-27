# @nd/ocpp-gateway

The OCPP 1.6J central system. myenergi's cloud opens one WebSocket per Zappi to it; the gateway authenticates the charger, answers its messages, stores every frame, and gives the API a small command interface (ChargerControl) and a stream of charger events. It runs as a single instance and keeps nothing in memory except the open sockets.

## Listeners

| Port | Path                       | Who calls it                    | What it is                                                  |
| ---- | -------------------------- | ------------------------------- | ----------------------------------------------------------- |
| 9000 | `/v16/<ChargeboxID>`       | Chargers, via the public proxy  | OCPP 1.6J WebSocket                                         |
| 9000 | `/healthz`, `/readyz`      | Container health checks         | Liveness; readiness also checks Postgres                    |
| 9100 | `POST /v1/commands/<name>` | The API, on the private network | ChargerControl, guarded by `Authorization: Bearer <secret>` |
| 9100 | `/healthz`                 | Health checks                   | Liveness of the internal listener                           |

The upgrade needs the `ocpp1.6` subprotocol (400 otherwise) and HTTP Basic Auth whose username is the ChargeboxID in the path and whose password matches the charger's argon2 hash: 401 for missing or wrong credentials (and for a charger with no hash yet), 404 for an unknown ChargeboxID. Nothing is stored for a refused upgrade. A second socket for a ChargeboxID replaces the first, which is closed with code 4000. Sockets are pinged every 30 s and cut off after a missed pong; on shutdown they are closed with 1001.

Charger secrets are stored as standard PHC argon2 strings (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`); `hashChargerSecret` in `@nd/db` (shared with the API, which hashes the secret when a host connects a charger) writes them with Node's built-in argon2, and hashes from any other argon2 library verify.

## Environment

| Variable                  | Default           | Meaning                                                                   |
| ------------------------- | ----------------- | ------------------------------------------------------------------------- |
| `HOST`, `PORT`            | `0.0.0.0`, `9000` | OCPP listener                                                             |
| `DATABASE_URL`            | required          | Postgres                                                                  |
| `GATEWAY_INTERNAL_SECRET` | required          | Bearer secret for ChargerControl, at least 32 characters                  |
| `GATEWAY_INTERNAL_HOST`   | `127.0.0.1`       | Internal listener interface (`0.0.0.0` in the image)                      |
| `GATEWAY_INTERNAL_PORT`   | `9100`            | Internal listener port                                                    |
| `LOG_LEVEL`               | `info`            | pino level; logs are JSON on stdout, with credentials and idTags redacted |

## What happens to each message

Every inbound CALL is inserted into `ocpp_messages` before its handler runs; if the insert fails the charger gets an `InternalError` CALLERROR and retries. Replies, outbound CALLs (with their UUID message ids) and the charger's answers are stored too. Inbound CALLs on one socket are handled in order, one at a time.

| From the charger     | Answer and effect                                                                                                                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BootNotification`   | Accepted, interval 300; charger `online`, firmware stored. Once the answer is sent, the boot configuration is read, only differing keys are written, and the full configuration is stored in `chargers.ocpp_config`                                                                                                        |
| `Heartbeat`          | Current time; `last_heartbeat_at` updated, an `offline` charger back to `online`                                                                                                                                                                                                                                           |
| `StatusNotification` | An error code other than `NoError` (or `Faulted`) makes the charger `faulted`; `Charging`, `SuspendedEV` and `SuspendedEVSE` move the open session                                                                                                                                                                         |
| `Authorize`          | `Accepted` for a booking's idTag while the booking is `arrived` or `active` and its slot is open on this charger, or for the host's tag outside paid windows; `Blocked` for the host's tag inside one; otherwise `Invalid`                                                                                                 |
| `StartTransaction`   | A booking idTag creates (or takes over the API's `starting`) session as `charging` with `meter_start_wh`, and makes the booking `active`. The host's tag or `PlugandChargeID` is a host session; inside a paid window it gets `Blocked` and a RemoteStop                                                                   |
| `MeterValues`        | `meter_values` rows: energy (Wh), power (W), current (A). Once a booking session has delivered its `kwh_cap` (highest reading less the start), `RemoteStopTransaction` after the reply: once per socket while the charger accepts it, again on the next MeterValues if it is rejected or unanswered, and after a reconnect |
| `StopTransaction`    | The session is `stopped` with `meter_stop_wh`, kWh and the reason (`needs_review` if the meter went backwards), and the booking `completed`. Payment work is left to the API                                                                                                                                               |
| `DataTransfer`       | `UnknownVendorId`, logged                                                                                                                                                                                                                                                                                                  |

Repeated StartTransaction and StopTransaction messages (a charger retrying after a lost answer) are recognised and answered without a second session or event.

The boot configuration is `FreeCharging=false`, `LocalAuthListEnabled=false`, `StopTransactionOnInvalidId=true`, `OCPPChargeMode=Fast`, `MeterValueSampleInterval=60` and `HeartbeatInterval=300`. ChangeConfiguration writes, from boot or from ChargerControl, are limited to 24 per charger in any rolling hour, counted from the outbound CALLs in `ocpp_messages`, so the limit holds across reconnects and restarts.

A charger whose last heartbeat is more than three intervals old is marked `offline`. The check runs at start and every minute and works only from `last_heartbeat_at`, so a restart neither loses nor double-counts a gap.

Host sessions have no `sessions` row (a session belongs to a booking); their frames are in `ocpp_messages`.

## ChargerControl

The contract and a typed client live in `@nd/domain` (`chargerControlCommands`, `createChargerControlClient`), so the API does not depend on this app:

```ts
import { createChargerControlClient } from "@nd/domain";

const control = createChargerControlClient({ baseUrl: "http://ocpp-gateway:9100", secret });
const result = await control.remoteStart({ chargeboxId, idTag });
if (result.ok) {
  // result.response is the charger's RemoteStartTransaction.conf
} else {
  // result.reason: "offline" | "no_response" | "call_error" | "budget_exhausted" | "send_failed"
}
```

Commands: `remoteStart`, `remoteStop` (`chargeboxId` and `transactionId`), `changeConfiguration`, `getConfiguration` (a read of every key also updates `chargers.ocpp_config`), `triggerMessage`, `reset` (always soft) and `unlockConnector`. A charger that does not answer within 30 s is `no_response`. The client throws `ChargerControlError` only when the gateway itself is unreachable or refuses the request.

## Charger events

The gateway publishes on the Postgres channel `charger_events`, in the same transaction as the rows an event refers to. The payload is versioned JSON (`v: 1`) described by `chargerEventSchema` in `@nd/domain`; parse it with `parseChargerEvent`. Types: `boot`, `status`, `fault`, `offline`, `online`, `session_started`, `meter` and `session_stopped`. NOTIFY is not durable, so a listener that reconnects should catch up from the tables.

## Tests

`pnpm test` runs the unit tests (the simulator against an in-memory store, and the Postgres store against a recording fake client). `pnpm test:integration` runs the simulator against a real gateway and Postgres at `DATABASE_URL`, in a database it creates and drops.
