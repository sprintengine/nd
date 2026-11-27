# Architecture

Peer-to-peer home EV charger sharing. A host lists a home charger, a driver books a slot (usually overnight), and the platform unlocks the charger over OCPP for that booking only, meters the session, and takes the driver's payment upfront, straight to the host.

This document describes the back end. The driver and host app is designed separately and will be added to the repository later. Key decisions are recorded in [docs/adr/](adr/).

## 1. Scope of the first version

| Area     | First version                                                                                                                                   | Later                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Chargers | myenergi Zappi v2.1 (serial starts with `2`) and Zappi GLO, firmware 5.794 or later, over OCPP 1.6J. Tethered and untethered. No 3-pin sockets. | Other brands, behind per-charger capability flags |
| Drivers  | Find a charger on a map, book a slot, start and stop from the app, live kWh, receipt, rating                                                    | Recurring bookings, favourites                    |
| Pricing  | Host sets a price per hour and a kWh cap. The driver pays the booked hours upfront; metered kWh is shown to both sides                          | Per-kWh billing once metering accuracy is settled |
| Payments | Stripe Connect Express destination charges, paid upfront; card fee passed on to the host (section 7)                                            | Promotions, fleet invoicing                       |
| Access   | Charger idles locked; each booking gets its own single-use OCPP idTag; the app starts the session remotely                                      | RFID cards                                        |
| Evidence | Every OCPP message and meter value stored per session                                                                                           | A second evidence source from the vendor's API    |
| Market   | UK and Ireland                                                                                                                                  |                                                   |

The platform charges no service fee in the first version. The fee is a configuration value (`PLATFORM_FEE_BPS`, default `0`), so it can be introduced without a schema change. Stripe's card fee is passed on to the host as an estimate (`CARD_FEE_BPS`, default 150, plus `CARD_FEE_FIXED_CENTS`, default 25).

## 2. System context

```mermaid
flowchart LR
  subgraph People
    D[Driver app]
    H[Host app]
  end
  subgraph Platform
    API[api<br/>Fastify, jobs, realtime]
    GW[ocpp-gateway<br/>OCPP 1.6J over wss]
    DB[(Postgres 17<br/>+ PostGIS)]
  end
  subgraph "Third parties"
    ME[myenergi cloud]
    Z[Zappi at the host's home]
    ST[Stripe Connect]
    PUSH[Push and email]
  end
  D -->|HTTPS + WebSocket| API
  H -->|HTTPS + WebSocket| API
  API --> DB
  GW --> DB
  API -->|internal HTTP, shared secret| GW
  GW -.->|LISTEN / NOTIFY| API
  API -->|destination charges, SetupIntents, refunds| ST
  ST -->|webhooks| API
  API --> PUSH
  Z <-->|vendor protocol| ME
  ME -->|opens the OCPP WebSocket| GW
```

**The charger never connects to us directly.** The host enters our OCPP URL and a ChargeboxID in their myenergi account, and myenergi's cloud opens the WebSocket to our public endpoint for them. As a result:

- The gateway must be reachable on a stable public hostname with a valid TLS certificate.
- A Zappi can be bound to only one OCPP backend at a time. Onboarding detects a charger that is already bound elsewhere and stops.
- Every link is cloud to cloud over the host's home internet. Session state in the app is always "last known at time T", never assumed live.
- OCPP has no way to fetch past usage. Anything the gateway did not record when it happened is gone, so the gateway writes every message to the database before it acknowledges it.

## 3. Deployables and repository layout

There are two deployable processes plus Postgres. There is no Redis and no separate worker ([ADR 0002](adr/0002-single-gateway-and-postgres-notify.md)).

| Deployable     | Responsibilities                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api`          | REST API with Zod-validated bodies and generated OpenAPI; auth (Better Auth); realtime WebSocket for apps; Stripe calls and webhooks; background jobs (pg-boss on the same Postgres) |
| `ocpp-gateway` | OCPP 1.6J central system: WebSocket endpoint, Zappi profile, message persistence, `ChargerControl` commands. One instance holding the socket map in memory                           |
| Postgres       | Postgres 17 with PostGIS. System of record, job queue and event bus between the two processes                                                                                        |

```
apps/
  api/            Fastify 5 API, jobs, realtime, webhooks
  ocpp-gateway/   OCPP 1.6J central system
packages/
  config/         tsconfig, ESLint and Vitest presets; typed env parsing
  db/             Drizzle ORM schema, migrations, queries
  domain/         State machines, pricing, shared Zod contracts (API <-> app)
  ocpp-core/      OCPP 1.6J types, framing and validation, kept free of app code so it can be published on its own
```

Both apps ship as Docker images and are configured only through environment variables ([ADR 0004](adr/0004-hosting-portability.md)).

## 4. Data model

```mermaid
erDiagram
  users ||--o| hosts : "may be"
  hosts ||--o{ chargers : owns
  hosts ||--o| host_tax_details : "reports with"
  chargers ||--o{ availability_rules : has
  chargers ||--o{ bookings : receives
  users ||--o{ bookings : makes
  bookings ||--o| sessions : produces
  sessions ||--o{ meter_values : records
  chargers ||--o{ ocpp_messages : "audit trail"
  bookings ||--o| payments : "paid by"
  payments ||--o{ refunds : "refunded by"
  bookings ||--o{ reviews : "rated by"
  bookings ||--o{ disputes : "may raise"

  users {
    uuid id PK
    text email
    text phone
    text display_name
    text stripe_customer_id
  }
  hosts {
    uuid id PK
    uuid user_id FK
    text stripe_account_id
    text payout_status
    text currency "EUR | GBP, from the payouts country"
    bool tax_details_complete
    tstzrange night_rate_window "cheap tariff hours, optional"
    int max_sessions_per_day
  }
  host_tax_details {
    uuid host_id PK
    text entity_type "individual | business"
    text legal_name
    text company_number
    text tax_country
    text tin_encrypted "AES-256-GCM"
    text tin_masked
    text encryption_key_id
  }
  chargers {
    uuid id PK
    uuid host_id FK
    text model "zappi_v2_1 | zappi_glo"
    text serial
    text chargebox_id
    text ocpp_secret_hash
    text firmware
    numeric max_kw
    text connector "tethered | untethered"
    geography location "Point, 4326"
    text address "revealed after booking"
    text status "onboarding | online | offline | faulted"
    jsonb ocpp_config
    text host_id_tag
    timestamptz last_heartbeat_at
  }
  availability_rules {
    uuid id PK
    uuid charger_id FK
    int weekday
    time start_time
    time end_time
    int price_per_hour_minor
    numeric kwh_cap
    bool instant_book
  }
  bookings {
    uuid id PK
    uuid charger_id FK
    uuid driver_id FK
    tstzrange slot
    text status
    text id_tag "20 chars, unique, single use"
    int quoted_amount_minor
    text currency "GBP | EUR"
    timestamptz scheduled_start_at "remote start at the slot start, or later"
    text vehicle_plate
  }
  sessions {
    uuid id PK
    uuid booking_id FK
    int ocpp_transaction_id
    int meter_start_wh
    int meter_stop_wh
    timestamptz started_at
    timestamptz stopped_at
    text stop_reason
    text status
  }
  meter_values {
    uuid session_id FK
    timestamptz ts
    int energy_wh
    numeric power_kw
  }
  ocpp_messages {
    uuid id PK
    uuid charger_id FK
    text direction "in | out"
    text message_id
    text action
    jsonb payload
    timestamptz ts
  }
  payments {
    uuid id PK
    uuid booking_id FK
    text stripe_payment_intent_id
    int amount_minor "the booking's price"
    int platform_fee_minor
    int card_fee_minor "passed on to the host"
    text capture_method "automatic | manual (a request)"
    text status "pending | authorised | paid | cancelled | failed"
  }
  refunds {
    uuid id PK
    uuid payment_id FK
    text stripe_refund_id
    int amount_minor
    text reason "driver_cancelled | host_cancelled | charger_fault | support"
    text status "pending | succeeded | failed"
  }
```

Rules the schema enforces:

- Money is stored as integers in minor units with an explicit currency. A host's currency follows the country of their payouts account (Ireland: EUR, UK: GBP), chosen at `POST /hosts`; their availability rules, and so the prices, charges and refunds of bookings on their chargers, use it.
- `bookings.slot` has an exclusion constraint per charger, so two confirmed or active bookings can never overlap.
- `bookings.id_tag` is generated server-side from a cryptographic random source, is unique, at most 20 characters (the OCPP limit) and valid only inside its booking window. It is the only credential a driver needs; drivers never learn the host's own tag or PIN.
- `chargers.location` is `geography(Point, 4326)` with a GiST index; search uses `ST_DWithin` and ranks by distance, then rating. Until a booking is confirmed, search returns the location rounded to about 150 m and never the address.
- `ocpp_messages` is append-only: the application role has no update or delete grant. It is the evidence file for disputes.
- Secrets (`ocpp_secret_hash`, and the encrypted TIN and date of birth in `host_tax_details`) are never in a query helper's default column list.
- Status columns are Postgres enums matching the state machines below.

## 5. State machines

The transition functions live in `@nd/domain` as pure, typed reducers. The API and the gateway apply them; neither changes status columns directly.

### 5.1 Booking

```mermaid
stateDiagram-v2
  [*] --> requested
  requested --> confirmed: host approves, or instant book
  requested --> cancelled: host declines, driver cancels, 24 h pass, or payment fails
  confirmed --> arrived: driver taps "I'm here" (paid, from 4 h before start)
  confirmed --> cancelled: either side cancels (policy applies)
  confirmed --> no_show: slot ends + 15 min with no arrival
  arrived --> active: StartTransaction received
  arrived --> completed: slot ends + 10 min, a start was tried, the car plugged in or the charger is down; refunded in full
  arrived --> no_show: slot ends + 10 min, never plugged in and no start tried
  active --> completed: StopTransaction received
  completed --> [*]
  cancelled --> [*]
  no_show --> [*]
```

Cancellation: a driver cancelling before the host's cutoff (default 2 hours before the start) is refunded in full; after the cutoff, or on a no-show, nothing is refunded. A host cancelling (or declining) always refunds (or releases) everything. An active booking cannot be cancelled, only stopped. Requests the host has not answered expire after 24 hours, or at the slot start if sooner.

### 5.2 Charger

`onboarding` becomes `online` on the first `BootNotification` with a known ChargeboxID and valid credentials. Three missed heartbeats (interval 300 s) make it `offline`. A `StatusNotification` with an error code other than `NoError` makes it `faulted`. Drivers only see `online` chargers.

### 5.3 Session

```mermaid
stateDiagram-v2
  [*] --> scheduled: delayed start booked
  [*] --> starting: RemoteStartTransaction accepted
  scheduled --> starting: start job fires at the slot start (or the chosen time)
  starting --> charging: StartTransaction
  starting --> failed: no StartTransaction within 120 s
  charging --> suspended_ev: StatusNotification SuspendedEV
  charging --> suspended_evse: StatusNotification SuspendedEVSE
  suspended_ev --> charging
  suspended_evse --> charging
  charging --> stopped: StopTransaction
  suspended_ev --> stopped
  suspended_evse --> stopped
  stopped --> reconciled: meter checked, kWh recorded
  stopped --> needs_review: meter mismatch
  charging --> reconciled: no StopTransaction 10 min after the slot, closed from the last meter value
  charging --> needs_review: no StopTransaction and no meter value to close from
  needs_review --> reconciled: checked by support
```

If `StartTransaction` does not arrive within 120 s of an accepted remote start, the gateway sends `TriggerMessage(StatusNotification)` and the app asks the driver to check the cable and try again.

**Scheduled start.** Hosts offer only the hours they choose (often their night-rate hours), and the driver books and pays for those hours. A driver may arrive and plug in up to `ARRIVAL_LEAD_MINUTES` (default 4 hours) before the slot: the booking records `scheduled_start_at` (the slot start, or a later `startAt` inside it), the charger stays locked, and a job sends the remote start then. Waiting is never billed. Zappi does not support OCPP smart-charging profiles in this mode, so the delay is driven from our side.

## 6. Session flow

```mermaid
sequenceDiagram
  autonumber
  participant Dr as Driver app
  participant API as api
  participant GW as ocpp-gateway
  participant ME as myenergi cloud
  participant Z as Zappi
  participant ST as Stripe

  Dr->>API: POST /bookings {chargerId, slot}
  API->>ST: charge the price (instant) or hold it (request; charged on approval)
  API-->>Dr: booking confirmed, idTag issued
  Note over Dr,Z: Driver arrives and plugs in (up to 4 h early); the start waits for the slot
  Dr->>API: POST /bookings/:id/start
  API->>GW: remoteStart(chargeboxId, idTag)
  GW->>ME: RemoteStartTransaction {idTag, connectorId: 1}
  ME-->>GW: Accepted
  ME->>Z: unlock and charge
  ME->>GW: StartTransaction {idTag, meterStart}
  GW->>GW: persist, then reply {transactionId, Accepted}
  GW-->>API: NOTIFY session started
  API-->>Dr: session:update {status: charging}
  loop every 60 s
    ME->>GW: MeterValues
    GW-->>API: NOTIFY session meter
    API-->>Dr: session:update {kwh, kw, elapsed, lastSeenAt}
  end
  Dr->>API: POST /bookings/:id/stop (or the slot ends)
  API->>GW: remoteStop(transactionId)
  GW->>ME: RemoteStopTransaction
  ME->>GW: StopTransaction {meterStop, reason}
  GW-->>API: NOTIFY session stopped
  API->>API: reconcile job: check the meter, record kWh
  API-->>Dr: receipt
```

If the slot ends while charging, the API sends `RemoteStopTransaction` 5 minutes after the end. If `StopTransaction` never arrives (for example the host's internet drops), a job closes the session from the last meter value 10 minutes after the window ends, recording its kWh; without a meter value it goes to support (`needs_review`). Nothing is billed at the end of a session: the booking was paid upfront.

## 7. Payments

Stripe Connect Express **destination charges, paid upfront** ([ADR 0005](adr/0005-pay-upfront.md), which supersedes [ADR 0003](adr/0003-payments-flow.md)). Each booking is one PaymentIntent on a saved card, off-session, with `transfer_data.destination` the host's Express account, so the host receives the money with the charge. Stripe handles host identity checks and payouts. A host can take bookings once Stripe reports payouts enabled and their tax details are complete.

**Price.** The booked hours at the host's hourly price, prorated by the minute. The slot is the charging window: nothing is billed by energy or by the minutes used, and a car that stops drawing power early still pays for the booking. kWh is shown for information.

**Fees.** `application_fee_amount` = the platform fee (`PLATFORM_FEE_BPS`, default 0) + the card-fee estimate (`CARD_FEE_BPS` of the price, rounded up, + `CARD_FEE_FIXED_CENTS`), never more than the price: Stripe's card fee is passed on to the host, and the platform nets about zero. `chargeSplit` in `@nd/domain` computes it; the host sees the gross, the card fee and their net when setting a price ("you receive €X an hour after card fees"), on receipts and on the dashboard.

**Charging.**

- Instant booking: the price is charged when the booking is made (automatic capture). A declined card cancels the booking (402).
- Request: the price is held on the card (manual capture) when the request is made, charged when the host approves, and released when the host declines, the driver cancels or the request expires (24 hours, or the slot start if sooner). A hold that has lapsed by the time the host approves cancels the booking.
- A booking cannot be arrived at, started, or unlocked at the charger (the gateway checks the idTag's booking) until its payment is `paid`.

**Refunds**, always with `reverse_transfer` and `refund_application_fee`, so the host's share and the fee are reversed in proportion:

| Case                                                                                                                                                       | Refund                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Driver cancels before the host's cutoff                                                                                                                    | Full                                                                 |
| Driver cancels after the cutoff, or no-show                                                                                                                | None                                                                 |
| Host cancels, or declines a request                                                                                                                        | Full (a request's hold is released)                                  |
| The charger let the driver down: a start that failed, the car plugged in but never charged, or the charger offline, with no session by the end of the slot | Full, automatically                                                  |
| Anything else (a session that went partly wrong, a dispute)                                                                                                | Support decides, full or partial (`POST /admin/bookings/:id/refund`) |

**Doing it safely.** Every change first claims the booking's status (a guarded update; a refund the change owes is recorded in the same transaction), then calls Stripe with one idempotency key per logical action: the booking's charge, its capture, its release, each refund (keyed by the refund row). A call that fails or goes unanswered is recorded on the payment or refund row, and a `resume-payment` job (queued at once, and by the minute sweep) finishes it with the same key, so nothing is charged, captured or refunded twice. The sweep also re-queues lifecycle jobs that went missing (request expiry, no-show).

**Webhooks** (`/webhooks/stripe`) are verified by signature and processed idempotently by event id. They only record what Stripe did and never move money: `payment_intent.succeeded`, `payment_failed` and `canceled` update the payment; `charge.refunded` confirms pending refunds; `charge.dispute.*` records card disputes for support; `account.updated` mirrors the host's payout status.

## 8. OCPP gateway: Zappi profile

### 8.1 Endpoint and security

- URL given to hosts: `wss://ocpp.<domain>/v16/` (myenergi appends the ChargeboxID, so the trailing slash matters).
- Security Profile 2: TLS, plus HTTP Basic Auth on the upgrade request. The username is the ChargeboxID; the password is a per-charger secret shown once during onboarding and stored as an argon2 hash. Wrong credentials get 401; an unknown ChargeboxID gets 404.
- The `ocpp1.6` subprotocol is required on upgrade; anything else is refused.
- One socket per charger, in an in-memory map keyed by ChargeboxID. A second connection for the same ChargeboxID replaces the first.
- **The gateway sends a WebSocket ping every 30 s** on each socket, so idle connections are not dropped by NAT or proxies on the way, and a dead peer is noticed quickly.

### 8.2 Messages

| From the charger     | Gateway response and action                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BootNotification`   | Accepted, interval 300. Charger `online`. Push the configuration set (8.3).                                                                                         |
| `Heartbeat`          | Current time. Update `last_heartbeat_at`.                                                                                                                           |
| `StatusNotification` | Update connector status; an error code other than `NoError` makes the charger `faulted`; `SuspendedEV` and `SuspendedEVSE` map to session states.                   |
| `Authorize`          | `Accepted` only for the idTag of a booking that is `arrived` or `active` inside its window, or for the host's own tag outside paid windows. Otherwise `Invalid`.    |
| `StartTransaction`   | Create the session and return a `transactionId`. The host's own tag during a paid window gets `Blocked` and a remote stop.                                          |
| `MeterValues`        | Append to `meter_values`; publish to the API. When the booking's kWh cap has been delivered, a remote stop (re-checked on later MeterValues and after a reconnect). |
| `StopTransaction`    | Close the session, publish, enqueue reconciliation.                                                                                                                 |
| `DataTransfer`       | `UnknownVendorId`; logged.                                                                                                                                          |

| To the charger           | When                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `RemoteStartTransaction` | Driver taps Start in the window, or the scheduled-start job fires.                              |
| `RemoteStopTransaction`  | Driver taps Stop, the window ends, the kWh cap is reached, or the host makes an emergency stop. |
| `ChangeConfiguration`    | After boot (8.3). At most 24 writes per charger per rolling hour, to protect its flash.         |
| `GetConfiguration`       | Verify the pushed set; store it in `chargers.ocpp_config`.                                      |
| `TriggerMessage`         | Recover state after a reconnect or a missing `StartTransaction`.                                |
| `Reset` (soft)           | A remote start was rejected because a stale transaction is still open; retried once.            |
| `UnlockConnector`        | Host support action.                                                                            |

Not used: `ReserveNow` (unsupported on Zappi), `SetChargingProfile` (not available in this mode), `SendLocalList` (the local list stays disabled so every tag is checked with us).

### 8.3 Configuration pushed on boot

```
FreeCharging = false              charger idles locked until we start it
LocalAuthListEnabled = false      every tag is sent to Authorize
StopTransactionOnInvalidId = true
OCPPChargeMode = Fast             case-sensitive
MeterValueSampleInterval = 60
HeartbeatInterval = 300
```

Onboarding also asks the host to change the charger's default PIN, confirm the charger is its own hub, and turn off any energy supplier smart-charging mode that would override our commands.

### 8.4 Persistence, timeouts and the API link

- Every inbound CALL is inserted into `ocpp_messages` before the CALLRESULT is sent. Every outbound CALL has a UUID message id and a 30 s reply timeout; a timeout is logged and surfaces in the app as "no response".
- The API calls the gateway's `ChargerControl` interface (`remoteStart`, `remoteStop`, `changeConfiguration`, `triggerMessage`, `reset`, `unlockConnector`) over an internal HTTP endpoint guarded by a shared secret and never exposed publicly. The interface leaves room to put a different central system behind it later.
- The gateway publishes events with Postgres `NOTIFY` on the `charger_events` channel. The payload carries only ids; the row is written first, and the API reads it. Because `NOTIFY` is not durable, the API also catches up from the tables when it reconnects.
- Apart from the socket map, the gateway keeps no state. A restart loses only in-flight commands, which the API retries; myenergi reconnects on its own.

## 9. API surface

REST with Zod-validated bodies, OpenAPI generated from the same schemas, cookie sessions, and a WebSocket at `/ws` for live updates. Authentication is Better Auth inside the API, with the Drizzle adapter on our Postgres: magic link, Sign in with Apple, Google and phone OTP.

```
GET    /healthz | /readyz                        liveness; readiness checks Postgres
GET    /openapi.json                             OpenAPI 3.1, generated from the Zod schemas

GET    /auth/* | POST /auth/*                    Better Auth routes
GET    /me                                       the user, with phone-verified and host flags
POST   /me/delete                                GDPR deletion after a 7-day undo window (section 10)
POST   /me/delete/cancel                         undo it with the emailed token

GET    /chargers?lat&lng&radius&from&to          search: online and free in the window
GET    /chargers/:id                             listing, approximate location until booked
POST   /hosts                                    become a host; returns a Stripe onboarding link
GET    /hosts/me/tax-details | PUT               tax identity for platform reporting; TIN masked on read
POST   /hosts/chargers                           start onboarding: wss URL, ChargeboxID, secret
GET    /hosts/chargers/:id/onboarding?wait=N     long-polls for the first BootNotification
PATCH  /hosts/chargers/:id                       pricing, availability, instant book, night-rate window
POST   /hosts/chargers/:id/stop                  host's emergency stop of the session charging now

POST   /bookings                                 request (price held) or instant-confirm (charged); rate limited
POST   /bookings/:id/approve | /decline          host: charge the held price, or release it
POST   /bookings/:id/cancel                      either side; refund rules applied
POST   /bookings/:id/arrive                      driver, inside the window
POST   /bookings/:id/start | /stop               remote start and stop
GET    /bookings/:id/session                     live state
GET    /bookings/:id/receipt                     price paid, refunds, the session as evidence
POST   /bookings/:id/review | /dispute           driver: rate the host; dispute a finished booking

POST   /admin/bookings/:id/refund                support: refund in full or in part
POST   /webhooks/stripe
```

Errors are `application/problem+json` (RFC 9457) with a stable `code` and the request id. Booking and hosting need a verified phone number (403 otherwise). Hosts see and change only their own chargers; any other charger id is 404. Search and listings are rate limited per client IP, and Better Auth limits its own routes.

Internal admin views (chargers, sessions, OCPP message log) come later, behind their own role.

### 9.1 Realtime

`GET /ws` upgrades to a WebSocket authenticated by the same Better Auth session cookie. The upgrade is refused with a problem response before any socket exists: 401 without a session, 403 when an `Origin` header is sent and is not one of `CORS_ORIGINS` (browsers always send one; native apps may not), and 429 when the user already holds 5 connections. The server pings every 30 s and drops a connection that missed the previous pong, re-checks each connection's session every 5 minutes (closing with code 4001 once it has ended), and drops a client whose unsent data passes 1 MiB rather than buffering without bound; the client reconnects and refetches.

Messages are JSON text frames with a `type`. Their Zod schemas (`serverMessageSchema`, `clientMessageSchema`, `sessionStateSchema`) live in `@nd/domain` (`realtime.ts`), so the app parses exactly what the API sends.

| `type`           | To                            | Body                                                                                                                                                                                                                                        |
| ---------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`          | the new connection            | `heartbeatSeconds`                                                                                                                                                                                                                          |
| `booking:update` | the booking's driver and host | `bookingId`, `status`, `at`. Fetch `GET /bookings/:id` for the rest                                                                                                                                                                         |
| `session:update` | the booking's driver and host | The live session, the same shape as `GET /bookings/:id/session`: `bookingId`, `sessionId`, `status`, `kwh`, `kw`, `elapsed` (seconds since charging started), `lastSeenAt`, `startAt`, `stoppedAt`, `stopReason`, `failure {code, message}` |
| `charger:status` | the charger's host            | `chargerId`, `status` (onboarding, online, offline, faulted), `connectorStatus` and `errorCode` from the latest StatusNotification, `at`                                                                                                    |
| `resync`         | everyone                      | The API's database link reconnected and events may have been missed: refetch what is on screen                                                                                                                                              |
| `pong`           | the sender                    | The answer to a client's `{"type": "ping"}` (browsers cannot send WebSocket pings). Clients send nothing else                                                                                                                               |

Two sources feed it: the gateway's `charger_events` (session started, meter, status, session stopped, and the charger's connection state), through the API's one `LISTEN` connection, and the API's own changes (arrival, start and stop, failed starts, and the booking routes). Each update re-reads the rows, so a message carries the current state, and nothing is read for a booking or charger no connected user may see.

The live session's `status` is a session status, or `not_started` before the first start, or `scheduled` while a delayed start waits. `elapsed` counts seconds since charging started; the booking was paid upfront, so the live state carries no running cost. `lastSeenAt` is when the charger last reported on the session; the app shows its age, since the state is always "last known at time T".

### 9.2 Session control

- **Arrive** (`POST /bookings/:id/arrive`, the driver of a paid booking, from `ARRIVAL_LEAD_MINUTES` (default 4 hours) before the slot until it ends): `confirmed` becomes `arrived`. A position sent with it is compared with the charger's and the distance recorded (more than 300 m is noted, never refused). The window-end stop is scheduled.
- **Start** (`POST /bookings/:id/start`, an arrived, paid booking; before the slot it becomes a scheduled start at the slot start): a `starting` session is created and `remoteStart(chargeboxId, idTag)` sent. Accepted: a job fails the start if no `StartTransaction` arrives within 120 s, and sends `TriggerMessage(StatusNotification)`. Rejected while the charger reports a transaction open: a soft `Reset`, and one retry by a job 20 s later. Rejected otherwise, offline or no answer: the session is `failed` with a reason and copy the app shows ("The charger didn't respond. Check the cable is plugged in, then try again."), and starting again retries. Starting while a start is pending or a session runs returns it unchanged.
- **Scheduled start**: `startAt` (inside the slot), or starting before the slot, records the plug-in and has a job send the remote start at that time; waiting is never billed.
- **Stop** (`POST /bookings/:id/stop`, the driver) sends `remoteStop(chargeboxId, transactionId)`; a job does the same 5 minutes after the slot ends. The session closes when `StopTransaction` arrives. Stopping is idempotent and changes nothing about what was paid.

## 10. Security, privacy and compliance hooks

- **Secrets:** per-charger OCPP secrets hashed with argon2; Stripe keys, database credentials and the gateway's shared secret only in the environment; nothing secret in the app bundle.
- **Input:** every request body, OCPP frame and environment variable is validated with Zod at the boundary.
- **Abuse:** rate limits on auth, search and booking (`BOOKING_RATE_LIMIT_PER_HOUR` per driver), at most 3 requests waiting per driver, a cap on sessions per host per day (checked under a per-host lock); an audit log for admin actions.
- **Driver identity:** verified email and phone; vehicle plate per booking (shown to the host); identity verification through Stripe when a host requires it.
- **Location privacy:** approximate pins and no address until a booking is confirmed.
- **Platform reporting:** hosts provide legal name, address, date of birth or company number, and a tax identification number with its country before they can publish a listing. The number and the date of birth are encrypted at rest (AES-256-GCM) with rotatable application keys; the number is validated per country and only ever shown masked. An annual export produces the EU DAC7 report for Irish hosts and the HMRC platform-operator report for UK hosts; neither has a minimum threshold for services.
- **Retention and deletion:** meter values and OCPP messages are kept for 24 months, then purged; sessions and accounting rows are kept. Deleting an account signs it out everywhere at once and, after a 7-day undo window, anonymises its personal data. The user row stays as a tombstone without personal data, so bookings, payments and refunds keep adding up, and the driver's Stripe Customer (with their saved cards) is deleted. A host who was paid keeps their tax details, still encrypted, for `TAX_RECORD_RETENTION_YEARS` (default 6) for platform reporting; the daily purge job removes them after that. Deletion waits until no booking is open and no payment or refund is still going through.
- **Regulatory posture:** sharing a private driveway charger by booking falls outside the UK public charge point rules, and keeping access booking-only (no walk-up QR codes) keeps the service clearly private under the EU's alternative fuels infrastructure rules in Ireland. 3-pin sockets are excluded. Both points are to be confirmed by legal review before launch.

## 11. Hosting

The deployment target is deliberately open ([ADR 0004](adr/0004-hosting-portability.md)): each app is a Docker image configured only by environment variables, with Postgres 17 + PostGIS as the single stateful dependency.

**Reference deployment:** one Hetzner VM running Docker Compose (api, ocpp-gateway, Postgres, and a reverse proxy), behind Cloudflare.

- `api.<domain>` (and the app later) is **proxied** by Cloudflare for DNS, TLS at the edge, caching and DDoS protection.
- `ocpp.<domain>` is **DNS-only**. myenergi's cloud holds one WebSocket per charger for days; a proxied WebSocket is cut by edge idle timeouts and dropped whenever the edge restarts, so the OCPP hostname resolves straight to the VM and TLS ends there, with a certificate the proxy obtains by ACME.
- The internal gateway endpoint is reachable only on the Compose network.
- Logs are JSON to stdout. Nightly `pg_dump` goes to object storage with 30-day retention.

**Alternative:** Cloudflare Containers for `api` and `ocpp-gateway`, with an external managed Postgres that supports PostGIS. This trades the VM for managed scaling, but the gateway must then run as exactly one always-on instance, and the OCPP socket goes through Cloudflare's edge, so the 30 s pings, reconnect handling and persist-before-ack design become essential rather than defensive.

## 12. Open questions

1. Can a Zappi keep an OCPP binding and a myenergi API consent at the same time? This decides whether the vendor's session history can be a second evidence source.
2. Is the Zappi's internal meter accurate enough to bill per kWh in the UK and Ireland? Until that is answered, billing is by time and kWh is informational.
3. What terms, pricing and rate limits apply to myenergi's third-party API?
4. Destination charges pay the host at the charge, so a later refund can leave a host's Stripe balance negative until later bookings cover it. Is that acceptable, or should payouts be delayed? Legal and Stripe review before launch.
5. What insurance should hosts have? Launch with a contractual guarantee and the per-host session cap.
