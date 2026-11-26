import { defineConfig } from "vitest/config";

// Runs every workspace's unit tests in one process (`pnpm vitest`) and powers
// editor integrations. CI runs them per package through Turborepo instead.
export default defineConfig({
  test: {
    projects: ["apps/*/vitest.config.ts", "packages/*/vitest.config.ts"],
  },
});
