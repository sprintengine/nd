# @nd/e2e

End-to-end tests. They run the real Docker images under Compose (`infra/compose.e2e.yml`: the api, the ocpp-gateway, a one-shot migrate, Postgres with PostGIS, stripe-mock and the Stripe double below) and drive them only through public interfaces: the HTTP API, the realtime WebSocket (`/ws`), signed Stripe webhooks, and the Zappi simulator from `@nd/ocpp-core/sim` connecting to the gateway as a real charger, with the credentials the API issued.

```sh
pnpm test:e2e                      # build the images, start the stack, run, tear down
E2E_NO_BUILD=1 pnpm test:e2e       # use nd-api:e2e and nd-ocpp-gateway:e2e as already built
E2E_KEEP_STACK=1 pnpm test:e2e     # leave the stack running afterwards
E2E_API_URL=http://127.0.0.1:13000 pnpm test:e2e   # use a stack that is already up
```

The stack's logs are written to `tests/e2e/stack.log` when the run ends. Host ports, image tags and the Compose project name can be moved (`E2E_API_PORT`, `E2E_GATEWAY_PORT`, `E2E_STRIPE_PORT`, `E2E_STRIPE_DOUBLE_PORT`, `E2E_IMAGE_TAG`, `COMPOSE_PROJECT_NAME`), so several stacks can run side by side. A run takes about four minutes; the stale-session scenario waits for a slot to end plus the grace.

## Scenarios

| File                   | What it covers                                                                                                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `charging.e2e.test.ts` | A host signs up (sign-in link and phone code), opens payouts, gives tax details, connects a Zappi with the issued credentials, sets price and hours and publishes. A driver finds it, books, is approved, arrives, starts, sees meter values, stops; the receipt bills the time used and the host's transfer is sent |
| `decline.e2e.test.ts`  | The host declines a request: the booking is cancelled by the host and the card hold released                                                                                                                                                                                                                         |
| `safety.e2e.test.ts`   | A charger with a wrong password, or none, is refused; a second booking of a held slot is refused; wrong ID tags are refused at the charger; only the booking's driver can start it                                                                                                                                   |
| `failures.e2e.test.ts` | A charger that never sends StartTransaction fails with `start_timeout`; a charger that drops mid-session is closed after the stale-session grace, then billed once the host confirms                                                                                                                                 |

The stack shortens three timings so these fit in a run: `SESSION_START_TIMEOUT_SECONDS=8`, `STALE_SESSION_GRACE_MINUTES=1` and `MIN_BOOKING_MINUTES=1`. Bookings happen in real time: a slot starts on the next whole minute, and the charger's availability is a window around now.

## Test hooks

- **Messages.** With `E2E_TEST_HOOKS=true` the API keeps the email and SMS it sends in memory and lists them at `GET /e2e/messages?to=…`; that is how the tests sign in and verify phone numbers. The API refuses the flag in production.
- **Stripe.** stripe-mock checks requests against Stripe's API but keeps no state. `stripe-double/server.ts`, a single file with no dependencies, sits in front of it: each call goes to stripe-mock first (a request Stripe would refuse is refused), then is answered from state kept in the double (unique ids, saved cards, manual-capture intents, partial captures, cancellations, transfers, idempotent replays). The tests confirm a SetupIntent with the double as the app's Stripe SDK would, send the webhooks Stripe would send (signed with the stack's test secret), and read what happened under `/__double/`. It is test-only and never deployed.
