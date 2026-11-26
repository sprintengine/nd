# 0001. Stack: TypeScript on Node.js 26 with Fastify, Drizzle, Zod and Postgres

- Status: Accepted
- Date: 2026-11-26

## Context

A small team builds an API, a long-running OCPP WebSocket server and, later, a driver and host app. Types should flow end to end, the toolchain should stay current for years, and nothing should lock the project to one vendor.

## Decision

- **Language and runtime:** TypeScript in strict mode, ESM only, on Node.js 26 (Active LTS). Sources use erasable syntax only, so Node.js runs them directly in development. Compilation uses TypeScript 7. Linting uses the TypeScript 6 API until typescript-eslint supports 7.
- **Workspace:** pnpm 10 workspaces with a strict version catalog, and Turborepo for task orchestration and caching.
- **API:** Fastify 5, Zod 4 schemas for every boundary (OpenAPI generated from them), Better Auth for authentication with its data in our Postgres.
- **Data:** Postgres 17 with PostGIS for geo search, Drizzle ORM over node-postgres, pg-boss for jobs on the same database.
- **OCPP:** an in-house OCPP 1.6J gateway. The Zappi uses a small, documented subset of about a dozen messages, and the gateway hides behind a `ChargerControl` interface.
- **Quality gates:** ESLint (typescript-eslint strict and stylistic, type-aware), Prettier, Vitest with v8 coverage thresholds per package, knip, syncpack, Conventional Commits.

## Consequences

- One language and one schema library are shared across API, gateway and app, with contracts in `@nd/domain`.
- Postgres is the only stateful service to run, back up and secure.
- Running TypeScript 7 alongside TypeScript 6 for linting is a temporary seam, documented in `pnpm-workspace.yaml`; remove it once typescript-eslint supports TypeScript 7.
- The gateway is code we own and must test well; the Zappi simulator and integration tests carry that weight.
