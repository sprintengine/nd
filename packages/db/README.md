# @nd/db

Drizzle ORM schema, SQL migrations and typed queries for Postgres 17 with PostGIS.

## Commands

Every command reads `DATABASE_URL` from the environment.

| Command                                              | What it does                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm db:migrate`                                    | Applies pending migrations in one transaction, under an advisory lock |
| `pnpm db:seed`                                       | Inserts development data; a second run does nothing                   |
| `pnpm --filter @nd/db db:generate`                   | Writes the next migration from changes to `src/schema`                |
| `pnpm --filter @nd/db db:generate --custom --name x` | Creates an empty migration for hand-written SQL                       |
| `pnpm --filter @nd/db test:integration`              | Integration tests; each file creates and drops its own database       |

From code, `runMigrations(databaseUrl)` does the same as `pnpm db:migrate`. A built image runs `node dist/main.js migrate` and needs the `drizzle/` folder next to `dist/`.

The seed is for development only (it refuses to run with `NODE_ENV=production`): three hosts, four chargers within 2 km of Ranelagh, Dublin 6 (53.326, -6.256), two drivers and a booking in every status, in EUR. Times are relative to when it runs, so the arrived and active bookings are current. Seeded chargers have no OCPP password hash.

## Schema

| Table                                                  | Holds                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users`                                                | People. Text id and the core fields Better Auth expects (`name`, `email`, `emailVerified`, `image`, timestamps), plus phone, the Stripe customer id and `deleted_at` once anonymised                                                                                                             |
| `hosts`                                                | A user who lists chargers: connected account, payout status, whether tax details are complete, cap on sessions per day, cancellation cutoff, optional night-rate window                                                                                                                          |
| `chargers`                                             | ChargeboxID, OCPP password hash, model and firmware, `geography(Point, 4326)` location (GiST index), address, status, pushed OCPP config                                                                                                                                                         |
| `availability_rules`                                   | Weekly windows in the charger's time zone with price per hour, kWh cap and instant book. A window that ends at or before its start runs past midnight                                                                                                                                            |
| `bookings`                                             | Slot (`tstzrange`), status, single-use idTag (unique, at most 20 characters, issued at confirmation), quote in cents and the hourly price it was made at, currency, arrival time and distance from the charger, `scheduled_start_at` and when the driver plugged in for it, cancellation details |
| `sessions`                                             | One OCPP transaction: transaction id, meter start and stop (Wh), kWh, start and stop times, stop reason, status                                                                                                                                                                                  |
| `meter_values`                                         | MeterValues samples per session: energy (Wh), power (W), current (A)                                                                                                                                                                                                                             |
| `ocpp_messages`                                        | Append-only log of every OCPP frame in and out                                                                                                                                                                                                                                                   |
| `payments`                                             | The driver's PaymentIntent or SetupIntent, the saved card and the charge, when to authorise, authorised, captured and platform fee amounts in cents, why authorising failed                                                                                                                      |
| `transfers`                                            | The transfer of the host's share after capture (one per payment), with a hold reason while held                                                                                                                                                                                                  |
| `stripe_webhook_events`                                | Ids of the Stripe webhook events already processed, so redeliveries are skipped                                                                                                                                                                                                                  |
| `reviews`, `disputes`                                  | Ratings each side leaves after a booking, and disputes raised on one                                                                                                                                                                                                                             |
| `device_tokens`                                        | Push notification tokens per user                                                                                                                                                                                                                                                                |
| `host_tax_details`                                     | A host's tax identity for platform reporting: legal name and date of birth, or company name and number; address; tax country; the TIN and date of birth encrypted by the API with the key named in `encryption_key_id`, and the TIN masked to its last three characters                          |
| `account_deletions`                                    | Requests to delete an account: when it falls due (7 days later), the hash of the emailed undo token, the chargers it took off the listings, and whether it was cancelled or completed                                                                                                            |
| `auth_sessions`, `auth_accounts`, `auth_verifications` | Better Auth's sessions (the cookie token), linked Apple and Google sign-ins, and short-lived magic-link tokens and phone codes. The API maps Better Auth's `user` model onto `users` (its phone fields onto `phone` and `phoneVerified`)                                                         |

Status columns are Postgres enums built from the lists in `@nd/domain`, so adding a status means a new migration. Money is integer cents with a currency column.

Rules the database enforces:

- **No double booking.** An exclusion constraint stops two bookings in `confirmed`, `arrived` or `active` from overlapping on one charger. Slots are half-open, so back-to-back bookings are fine.
- **Append-only OCPP log.** Triggers reject `UPDATE`, `DELETE` and `TRUNCATE` on `ocpp_messages` for every role, the owner included. The one way to remove rows is `select purge_ocpp_messages()`, which runs as the owner, deletes only rows older than the 24-month retention period, and is not executable by `PUBLIC`. Run the application as a role that does not own the tables.
- **Audit rows outlive their parents.** Foreign keys are `ON DELETE NO ACTION`, except availability rules (deleted with their charger), and device tokens and the `auth_*` sessions and accounts (deleted with their user).

The extensions (`postgis`, `btree_gist`), the exclusion constraint and the OCPP triggers are hand-written migrations in `drizzle/`. drizzle-kit compares only its own snapshots, so it leaves them alone.

## Queries

- `createDb(databaseUrl)` returns a lazily connecting pool and the Drizzle client; `databaseUrlFromEnv()` reads and validates `DATABASE_URL`.
- `searchChargers(db, { point, radiusM, window })` returns chargers that are online and accepting bookings, within the radius (`ST_DWithin`), with one availability rule covering the whole window and no slot-holding booking overlapping it, nearest first. Results never carry the exact location or the address: the position is snapped to a fixed grid of about 150 m and the distance rounded to 100 m.
- `bookingsInWindow(db, { chargerId, window, statuses? })` returns a charger's bookings that overlap a window.
- `openTransactionForCharger(db, chargerId)` returns the session still running on a charger, with its booking.
- `chargerColumns` is every charger column except the OCPP password hash, and `hostColumns` every host column. Use them, or the `find*` helpers, for ordinary reads. `findChargerCredentials` is the only helper that returns the OCPP password hash.
