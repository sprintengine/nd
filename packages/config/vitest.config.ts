import { defineUnitConfig } from "./vitest.ts";

export default defineUnitConfig({
  coverageThresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
});
