import { defineUnitConfig } from "@nd/config/vitest";

export default defineUnitConfig({
  coverageThresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
});
