import { defineUnitConfig } from "@nd/config/vitest";

export default defineUnitConfig({
  coverageThresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
});
