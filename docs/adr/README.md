# Architecture decision records

Short records of decisions that shape the system: the context, what was decided and what follows from it. Add a new numbered file for a new decision; to change one, add a record that supersedes it and update the old record's status.

| ADR                                                | Decision                                                                     | Status             |
| -------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------ |
| [0001](0001-stack.md)                              | TypeScript on Node.js 26 with Fastify, Drizzle, Zod and Postgres             | Accepted           |
| [0002](0002-single-gateway-and-postgres-notify.md) | Two deployables, a single OCPP gateway, Postgres NOTIFY                      | Accepted           |
| [0003](0003-payments-flow.md)                      | Stripe Connect Express with separate charges and transfers                   | Superseded by 0005 |
| [0004](0004-hosting-portability.md)                | Docker images and env config; reference deployment on a VM behind Cloudflare | Accepted           |
| [0005](0005-pay-upfront.md)                        | Pay upfront with destination charges; card fee passed on to the host         | Accepted           |
