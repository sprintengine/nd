import { describe, expect, it } from "vitest";

import { TELEMETRY_RETENTION_MONTHS, telemetryCutoff } from "./retention.ts";

describe("telemetryCutoff", () => {
  it("counts 24 calendar months back from now", () => {
    expect(TELEMETRY_RETENTION_MONTHS).toBe(24);
    expect(telemetryCutoff(new Date("2027-03-15T10:00:00Z")).toISOString()).toBe(
      "2025-03-15T10:00:00.000Z",
    );
  });
});
