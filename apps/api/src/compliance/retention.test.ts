import { describe, expect, it } from "vitest";

import { scriptedDb } from "../../test/fake-db.ts";
import { purgeExpiredTelemetry, TELEMETRY_RETENTION_MONTHS, telemetryCutoff } from "./retention.ts";

describe("telemetryCutoff", () => {
  it("counts 24 calendar months back from now", () => {
    expect(TELEMETRY_RETENTION_MONTHS).toBe(24);
    expect(telemetryCutoff(new Date("2027-03-15T10:00:00Z")).toISOString()).toBe(
      "2025-03-15T10:00:00.000Z",
    );
  });
});

describe("purgeExpiredTelemetry", () => {
  it("purges OCPP messages and deletes meter values in batches until a short one", async () => {
    const full = Array.from({ length: 10_000 }, (_, index) => [index]);
    const { db, queries } = scriptedDb([[{ deleted: "3" }], full, [[1], [2]]]);
    const now = new Date("2027-03-15T10:00:00Z");
    await expect(purgeExpiredTelemetry(db, now)).resolves.toEqual({
      ocppMessages: 3,
      meterValues: 10_002,
    });
    expect(queries[0]?.text).toBe("select purge_ocpp_messages() as deleted");
    expect(queries).toHaveLength(3);
    expect(queries[1]?.params[0]).toBe("2025-03-15T10:00:00.000Z");
  });

  it("counts nothing when nothing is old enough", async () => {
    await expect(purgeExpiredTelemetry(scriptedDb().db, new Date())).resolves.toEqual({
      ocppMessages: 0,
      meterValues: 0,
    });
  });
});
