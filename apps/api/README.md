# @nd/api

The HTTP API: accounts (Better Auth), charger search and listings, and host onboarding. Fastify 5 with Zod schemas for every request and response; the OpenAPI 3.1 document is generated from them and served at `/openapi.json`.

## Running locally

```sh
pnpm db:up                         # Postgres with PostGIS on localhost:54320
pnpm db:migrate && pnpm db:seed
export DATABASE_URL=postgres://nd:nd@localhost:54320/nd
export AUTH_SECRET=$(openssl rand -hex 32)
export GATEWAY_INTERNAL_SECRET=$(openssl rand -hex 32)   # the same value the gateway uses
export CORS_ORIGINS=http://localhost:5173
pnpm --filter @nd/api dev          # http://localhost:3000
```

Sign-in links and phone codes are written to the console in development. To sign in with curl:

```sh
curl -X POST localhost:3000/auth/sign-in/magic-link -H 'content-type: application/json' \
  -H 'origin: http://localhost:5173' -d '{"email":"dev@example.com"}'
# open the link printed in the API's console; it sets the session cookie
```

`node dist/migrate.js` (or `pnpm --filter @nd/api migrate` from source) applies pending migrations and exits; the Docker image runs it as a one-off container before an upgrade.

## Environment

Every variable is validated at start-up (`src/env.ts`); a bad value stops the process with a message naming it. Optional values that are empty count as unset.

| Variable                                   | Default                    | Purpose                                                                                     |
| ------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                             | required                   | Postgres with PostGIS                                                                       |
| `AUTH_SECRET`                              | required                   | Signs session cookies and tokens; at least 32 characters                                    |
| `NODE_ENV`                                 | `development`              | `production` requires https and wss URLs and stops console senders printing links and codes |
| `HOST`, `PORT`                             | `0.0.0.0`, `3000`          | Where to listen                                                                             |
| `LOG_LEVEL`                                | `info`                     | pino level; cookies, authorization headers and secrets are redacted                         |
| `PUBLIC_API_URL`                           | `http://localhost:3000`    | Base of magic links and OAuth callbacks; https makes cookies `Secure`                       |
| `PUBLIC_APP_URL`                           | `http://localhost:5173`    | The web app; trusted by Better Auth and the target of Stripe's return links                 |
| `CORS_ORIGINS`                             | none                       | Comma-separated origins allowed to call with cookies                                        |
| `COOKIE_DOMAIN`                            | unset                      | Parent domain to share the session cookie across subdomains                                 |
| `TRUST_PROXY_HOPS`                         | `0`                        | Reverse proxies in front of the API whose `X-Forwarded-For` is trusted                      |
| `AUTH_RATE_LIMIT`                          | `on`                       | Better Auth's rate limiter (`off` only for local experiments)                               |
| `SEARCH_RATE_LIMIT_PER_MINUTE`             | `60`                       | Per client IP, on `GET /chargers` and `GET /chargers/:id`                                   |
| `APPLE_CLIENT_ID`, `APPLE_CLIENT_SECRET`   | unset                      | Sign in with Apple; both or neither. `APPLE_APP_BUNDLE_ID` for native ID tokens             |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | unset                      | Sign in with Google; both or neither                                                        |
| `EMAIL_PROVIDER`, `SMS_PROVIDER`           | `console`                  | Only the console senders exist so far                                                       |
| `STRIPE_SECRET_KEY`                        | unset                      | Stripe Connect for host payouts; without it `POST /hosts` answers 503                       |
| `STRIPE_API_BASE_URL`                      | Stripe                     | Another Stripe API, e.g. stripe-mock in end-to-end tests                                    |
| `OCPP_WSS_URL`                             | `ws://localhost:9000/v16/` | The OCPP URL hosts enter in their charger account; must end in `/`                          |
| `GATEWAY_INTERNAL_URL`                     | `http://localhost:9100`    | The gateway's internal ChargerControl endpoint                                              |
| `GATEWAY_INTERNAL_SECRET`                  | required                   | Bearer secret shared with the gateway; at least 32 characters                               |
| `ONBOARDING_WAIT_MAX_SECONDS`              | `25`                       | Longest the onboarding long-poll waits                                                      |

## How it fits together

- `src/app.ts` builds the app from injected dependencies (`src/deps.ts`): the database, a clock, an id generator, email and SMS senders, Stripe Connect, `ChargerControl` (the gateway's commands, typed by the `@nd/domain` contract; `main.ts` uses its HTTP client) and the charger event subscription. Tests pass fakes.
- **Auth** (`src/auth/`): Better Auth at `/auth/*` on the Drizzle adapter, with its `user` model mapped onto `users` and its sessions, accounts and verifications in the `auth_*` tables. Magic links last 15 minutes and work once; phone codes verify the signed-in user's number and never sign anyone in. Sessions are httpOnly cookies for 30 days, renewed daily while used, and revocable through Better Auth's sign-out and session routes. One `onRequest` hook resolves the session; `requireUser` and `requireVerifiedPhone` guard routes.
- **Search and listings** (`src/routes/chargers.ts`): search uses `searchChargers` from `@nd/db`, which never returns exact positions. A listing shows free slots for the next 7 days, from availability rules in the charger's time zone minus bookings that hold the charger. The address and exact position are shown only to a driver with a confirmed, arrived or active booking there.
- **Host onboarding** (`src/routes/hosts.ts`): only the Zappi v2.1 (serial starting with 2) and GLO can connect. The OCPP password is 20 random characters, returned once and stored as an argon2id PHC string by `hashChargerSecret` from `@nd/db`, the helper the gateway verifies it with. The onboarding long-poll subscribes to `LISTEN charger_events`, then re-reads the charger on every event (parsed with the versioned `@nd/domain` contract; anything else is skipped) and after a reconnect, because NOTIFY is not durable.
- Data access lives in `src/data/`; unit tests mock it, integration tests run it against Postgres.
- Errors are `application/problem+json` (`src/http/problem.ts`), including Better Auth's, which keep its `code` and `message`.

## Tests

```sh
pnpm --filter @nd/api test                 # unit tests with coverage; no database
DATABASE_URL=postgres://nd:nd@localhost:54320/nd pnpm --filter @nd/api test:integration
```

Integration tests create and drop their own database per file. `src/__snapshots__/openapi.json` is the committed API contract: a change to a route's schema fails the unit tests until the snapshot is updated (`pnpm --filter @nd/api exec vitest run -u`), so contract changes show up in review.
