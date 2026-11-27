import { defineConfig } from "vitest/config";

// The scenarios run against the stack src/stack.ts starts. Each file signs up
// its own people and chargers, so files run in parallel; the tests inside a
// file run in order, as one story.
const conditions = ["@nd/source", "module", "node", "development|production"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    environment: "node",
    include: ["src/**/*.e2e.test.ts"],
    globalSetup: ["src/stack.ts"],
    reporters: ["verbose"],
    testTimeout: 240_000,
    hookTimeout: 120_000,
    sequence: { concurrent: false },
  },
});
