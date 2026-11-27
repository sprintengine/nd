import { describe, expect, it } from "vitest";

import { scriptedDb } from "../../test/fake-db.ts";
import {
  purgeExpiredTaxRecords,
  purgeExpiredTelemetry,
  TELEMETRY_RETENTION_MONTHS,
  telemetryCutoff,
} from "./retention.ts";

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

describe("purgeExpiredTaxRecords", () => {
  it("deletes the tax details whose retention has ended", async () => {
    const now = new Date("2033-01-12T00:00:00Z");
    const { db, queries } = scriptedDb([[["host-1"], ["host-2"]]]);
    await expect(purgeExpiredTaxRecords(db, now)).resolves.toBe(2);
    expect(queries[0]?.text).toContain('delete from "host_tax_details"');
    expect(queries[0]?.text).toContain('"retain_until" <= $1');
    expect(queries[0]?.params).toEqual([now.toISOString()]);
  });
});
