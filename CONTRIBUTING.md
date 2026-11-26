# Contributing

Thanks for helping. This guide covers how to get set up, how changes are made, and what CI expects.

## Setup

Follow [Prerequisites and Getting started](README.md#prerequisites) in the README. `pnpm install` installs the git hooks:

- **pre-commit** formats staged files with Prettier and fixes them with ESLint.
- **commit-msg** checks the message with commitlint.

## Making a change

1. Branch from `main` (`feat/booking-routes`, `fix/gateway-reconnect`).
2. Make the change with tests. Keep each commit to one logical change.
3. Run the checks: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm knip`, plus `pnpm db:up && pnpm test:integration` when you touch the database.
4. Open a pull request using the template. CI must be green before it merges.
5. Pull requests are merged with a merge commit (no squash, no rebase), so write commits you are happy to keep.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), checked by `@commitlint/config-conventional`:

```
<type>(<optional scope>): <summary in the imperative>

<body: why the change is needed and anything surprising>
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `revert`, `style`. Useful scopes are the workspace names: `api`, `ocpp-gateway`, `db`, `domain`, `ocpp-core`, `config`. The PR title follows the same format.

## Code conventions

- TypeScript strict mode, ESM only, erasable syntax only (no `enum`, `namespace` or parameter properties) so Node.js can run sources directly.
- Relative imports include the `.ts` extension (`import { x } from "./x.ts"`); `tsc` rewrites them to `.js` in `dist/`.
- Validate external input (HTTP bodies, OCPP frames, environment) with Zod at the boundary. Shared contracts live in `@nd/domain`.
- Every OCPP message is persisted before it is acknowledged. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tests and coverage

- Unit tests sit next to the code as `src/**/*.test.ts`. They must not need the network or a database.
- Integration tests are `src/**/*.int.test.ts`, run by `pnpm test:integration` against `DATABASE_URL`. A package opts in by adding a `test:integration` script and a `vitest.integration.config.ts`.
- End-to-end tests are `tests/e2e/src/**/*.e2e.test.ts`, run by `pnpm test:e2e` against the built Docker images (see tests/e2e/README.md). They use only public interfaces: the HTTP API, the realtime WebSocket and the Zappi simulator connecting to the gateway.
- Each package sets coverage thresholds in its `vitest.config.ts`. Raise them as code lands; do not lower them to get a change through.
- Entry points (`src/main.ts`) are excluded from coverage; keep them to wiring only.

## Dependencies

- External versions live in the `catalog` in `pnpm-workspace.yaml`; packages refer to them as `"catalog:"`. `pnpm lint:packages` (syncpack) and the strict catalog mode enforce this.
- Internal packages use `"workspace:*"`.
- Add dependencies to the package that imports them; `pnpm knip` flags anything unused or missing.
- Dependabot opens grouped weekly updates.

## Adding a package

Copy an existing package of the same kind (`packages/domain` for a library, `apps/api` for a deployable) and keep the same scripts, the `@nd/source` export condition and the two tsconfig files. Pick initial coverage thresholds the package already passes.

## What not to commit

This repository is public. Do not commit secrets, `.env` files, personal data, real charger serials or credentials, or details of anyone's machine or network. Use placeholders such as `dev@example.com` in fixtures.
