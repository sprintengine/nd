import { describe, expect, it } from "vitest";

import {
  checkMeter,
  HOST_CONFIRMATION_HOURS,
  hostConfirmationDueAt,
  METER_TOLERANCE_WH,
  staleSessionCloseAt,
  whToKwh,
} from "./reconciliation.ts";

describe("checkMeter", () => {
  it("takes the delta when the last MeterValue agrees within 0.2 kWh", () => {
    expect(
      checkMeter({ meterStartWh: 1_000, meterStopWh: 23_500, lastMeterValueWh: 23_300 }),
    ).toEqual({ ok: true, deliveredWh: 22_500 });
    expect(
      checkMeter({ meterStartWh: 1_000, meterStopWh: 23_500, lastMeterValueWh: 23_700 }),
    ).toEqual({ ok: true, deliveredWh: 22_500 });
  });

  it("flags a disagreement beyond the tolerance", () => {
    expect(
      checkMeter({
        meterStartWh: 1_000,
        meterStopWh: 23_500,
        lastMeterValueWh: 23_500 - METER_TOLERANCE_WH - 1,
      }),
    ).toEqual({ ok: false, reason: "meter_mismatch", deliveredWh: 22_500 });
    expect(
      checkMeter({ meterStartWh: 1_000, meterStopWh: 23_500, lastMeterValueWh: 24_000 }),
    ).toMatchObject({ ok: false, reason: "meter_mismatch" });
  });

  it("takes the delta when there is no MeterValue to compare with", () => {
    expect(checkMeter({ meterStartWh: 0, meterStopWh: 300, lastMeterValueWh: null })).toEqual({
      ok: true,
      deliveredWh: 300,
    });
  });

  it.each([
    [null, 100],
    [100, null],
    [500, 100],
  ])("refuses start %s and stop %s", (meterStartWh, meterStopWh) => {
    expect(checkMeter({ meterStartWh, meterStopWh, lastMeterValueWh: 100 })).toEqual({
      ok: false,
      reason: "meter_invalid",
      deliveredWh: null,
    });
  });
});

describe("times and units", () => {
  it("converts Wh to kWh with three decimals", () => {
    expect(whToKwh(22_500)).toBe(22.5);
    expect(whToKwh(1)).toBe(0.001);
  });

  it("closes a stale session 10 minutes after the slot and waits 72 hours for the host", () => {
    const end = new Date("2027-01-12T06:00:00Z");
    expect(staleSessionCloseAt(end)).toEqual(new Date("2027-01-12T06:10:00Z"));
    expect(hostConfirmationDueAt(end)).toEqual(new Date("2027-01-15T06:00:00Z"));
    expect(HOST_CONFIRMATION_HOURS).toBe(72);
  });
});
