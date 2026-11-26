import { defineConfig, type ViteUserConfig } from "vitest/config";

/** Coverage floor for one package. Raise it as the package grows; never lower it. */
export interface CoverageThresholds {
  readonly lines: number;
  readonly functions: number;
  readonly branches: number;
  readonly statements: number;
}

/** Connection string for the Postgres started by `pnpm db:up` (docker-compose.dev.yml). */
export const DEV_DATABASE_URL = "postgres://nd:nd@localhost:54320/nd";

// Resolve workspace packages to their TypeScript source, so tests never need a build.
const conditions = ["@nd/source", "module", "node", "development|production"];

const shared = {
  resolve: { conditions },
  ssr: { resolve: { conditions } },
} satisfies ViteUserConfig;

/**
 * Unit tests: `src/**\/*.test.ts`, no network or database, v8 coverage with
 * per-package thresholds. Entry points (`src/main.ts`) are excluded from coverage.
 */
export function defineUnitConfig(options: { coverageThresholds: CoverageThresholds }): ViteUserConfig {
  return defineConfig({
    ...shared,
    test: {
      environment: "node",
      include: ["src/**/*.test.ts"],
      exclude: ["src/**/*.int.test.ts"],
      coverage: {
        provider: "v8",
        include: ["src/**/*.ts"],
        exclude: ["src/**/*.test.ts", "src/main.ts"],
        reporter: ["text", "json-summary", "lcov"],
        thresholds: { ...options.coverageThresholds },
      },
    },
  });
}

/**
 * Integration tests: `src/**\/*.int.test.ts`, run one file at a time against
 * a real Postgres at `DATABASE_URL` (defaults to the dev compose database).
 */
export function defineIntegrationConfig(): ViteUserConfig {
  return defineConfig({
    ...shared,
    test: {
      environment: "node",
      include: ["src/**/*.int.test.ts"],
      fileParallelism: false,
      testTimeout: 30_000,
      hookTimeout: 30_000,
      env: { DATABASE_URL: process.env["DATABASE_URL"] ?? DEV_DATABASE_URL },
    },
  });
}
