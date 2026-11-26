# nd

Peer-to-peer home EV charger sharing. Hosts list a home charger, drivers book an overnight slot, and the platform unlocks the charger over OCPP for that booking, meters the session and pays the host.

The first supported charger is the myenergi Zappi (v2.1 and GLO), connected over OCPP 1.6J. The target market is the UK and Ireland.

> **Status:** early development. This repository holds the back end (API, OCPP gateway and shared packages). The driver and host app will follow. The product name is not final; packages use the neutral `@nd/*` scope.

- [Architecture](docs/ARCHITECTURE.md)
- [Architecture decision records](docs/adr/)
- [Deploying](docs/DEPLOY.md) and the [runbook](docs/RUNBOOK.md)
- [Contributing](CONTRIBUTING.md) and [security policy](SECURITY.md)

## Layout

```
apps/
  api/            Fastify 5 HTTP + WebSocket API, background jobs, Stripe webhooks
  ocpp-gateway/   OCPP 1.6J central system the chargers connect to over WebSocket
packages/
  config/         Shared tsconfig, ESLint and Vitest presets; typed env parsing (Zod)
  db/             Drizzle ORM schema, migrations and access for Postgres + PostGIS
  domain/         Booking and session rules, pricing, shared Zod contracts
  ocpp-core/      OCPP 1.6J message types, framing and validation
infra/            Production Compose stack, Caddy config, backups, e2e smoke test
docs/             Architecture, decision records, deployment and runbook
```

A pnpm workspace with Turborepo. Everything is TypeScript, ESM only, strict mode.

## Prerequisites

- Node.js 26 (Active LTS). `.nvmrc` pins the major version: `nvm use` or `fnm use`.
- pnpm 10: `npm install -g pnpm@10`. The exact version is pinned in `packageManager`.
- Docker, for the local Postgres used by integration tests.

Installs are engine-strict: they fail on other Node.js or pnpm majors.

## Getting started

```sh
pnpm install          # also installs the git hooks (lefthook)
pnpm db:up            # Postgres 17 + PostGIS on localhost:54320
export DATABASE_URL=postgres://nd:nd@localhost:54320/nd
pnpm db:migrate       # apply the schema migrations
pnpm db:seed          # optional: sample hosts, chargers and bookings around Dublin 6
pnpm dev              # api on :3000 and ocpp-gateway on :9000, restart on change
```

To run one app on another port: `PORT=3100 pnpm --filter @nd/api dev`.

`pnpm dev` runs the TypeScript sources directly on Node.js (type stripping), so there is no build step in development. Each app reads its configuration from environment variables; see [`.env.example`](.env.example). Health checks: `GET /healthz` on either app.

## Checks

| Command                 | What it does                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `pnpm format:check`     | Prettier check (`pnpm format` to fix)                                              |
| `pnpm lint`             | ESLint with type-aware typescript-eslint rules, per package and for root files     |
| `pnpm lint:packages`    | syncpack: every package takes dependency versions from the pnpm catalog            |
| `pnpm typecheck`        | `tsc` over every package                                                           |
| `pnpm test`             | Unit tests with v8 coverage; each package enforces its own coverage thresholds     |
| `pnpm test:integration` | Integration tests against Postgres at `DATABASE_URL` (defaults to the dev compose) |
| `pnpm build`            | Compiles every package to `dist/`                                                  |
| `pnpm knip`             | Unused files, exports and dependencies                                             |

The integration database URL is:

```sh
DATABASE_URL=postgres://nd:nd@localhost:54320/nd
```

`pnpm db:down` stops it; add `-v` to the compose command to drop the data volume.

CI runs the same commands on every pull request, plus commit message and PR title checks, CodeQL, dependency review, actionlint and zizmor.

## Commits and merging

- Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat(api): add booking routes`). The commit-msg hook and CI both run commitlint.
- Keep each commit to one logical change. Pull requests are merged with a **merge commit**, never squashed or rebased, so the individual commits stay on `main`.

## Toolchain notes

- TypeScript 7 (the native compiler) runs every `tsc`. typescript-eslint still needs the TypeScript 6 compiler API, so `@nd/config` alone resolves `typescript` to `@typescript/typescript6` through the `lint` catalog in `pnpm-workspace.yaml`.
- Workspace packages export their source under the `@nd/source` condition. Typecheck, tests and `pnpm dev` use it, so no package needs building first; `pnpm build` and production use `dist/`.

## Licence

[Apache-2.0](LICENSE).
