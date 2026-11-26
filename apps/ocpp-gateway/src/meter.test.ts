import { describe, expect, it } from "vitest";

import { extractMeterSamples } from "./meter.ts";

const timestamp = "2027-01-13T23:00:00.000Z";

describe("extractMeterSamples", () => {
  it("reads energy, power and current in base units", () => {
    expect(
      extractMeterSamples([
        {
          timestamp,
          sampledValue: [
            { value: "12345.6", measurand: "Energy.Active.Import.Register", unit: "Wh" },
            { value: "7.2", measurand: "Power.Active.Import", unit: "kW" },
            { value: "31.256", measurand: "Current.Import", unit: "A" },
            { value: "230", measurand: "Voltage", unit: "V" },
          ],
        },
      ]),
    ).toEqual([{ ts: new Date(timestamp), energyWh: 12346, powerW: 7200, currentA: 31.26 }]);
  });

  it("defaults the measurand to the energy register and the unit to Wh", () => {
    expect(
      extractMeterSamples([
        { timestamp, sampledValue: [{ value: "1.5", unit: "kWh" }, { value: "9" }] },
      ]),
    ).toEqual([{ ts: new Date(timestamp), energyWh: 1500, powerW: null, currentA: null }]);
  });

  it("combines phases: energy and power summed, current the largest", () => {
    const [sample] = extractMeterSamples([
      {
        timestamp,
        sampledValue: [
          { value: "100", measurand: "Power.Active.Import", phase: "L1" },
          { value: "200", measurand: "Power.Active.Import", phase: "L2" },
          { value: "50", measurand: "Power.Active.Import", phase: "N" },
          { value: "10", measurand: "Current.Import", phase: "L1" },
          { value: "12", measurand: "Current.Import", phase: "L3" },
        ],
      },
    ]);
    expect(sample).toMatchObject({ powerW: 300, currentA: 12, energyWh: null });
  });

  it("skips unknown units, non-numbers and empty readings", () => {
    expect(
      extractMeterSamples([
        { timestamp, sampledValue: [] },
        {
          timestamp,
          sampledValue: [
            { value: "abc", measurand: "Power.Active.Import" },
            { value: "", measurand: "Current.Import" },
            { value: "5", measurand: "Energy.Active.Import.Register", unit: "varh" },
            { value: "x", measurand: "Power.Active.Import", phase: "L1" },
          ],
        },
      ]),
    ).toEqual([]);
  });
});
