import type { MeterValue, SampledValue } from "@nd/ocpp-core";

/** One stored meter sample: what `meter_values` keeps from a MeterValue. */
export interface MeterSample {
  readonly ts: Date;
  /** Energy.Active.Import.Register, Wh. */
  readonly energyWh: number | null;
  /** Power.Active.Import, W. */
  readonly powerW: number | null;
  /** Current.Import, A. */
  readonly currentA: number | null;
}

const SCALE: Partial<Record<string, number>> = { Wh: 1, kWh: 1000, W: 1, kW: 1000, A: 1 };

function numeric(sample: SampledValue, defaultUnit: string): number | undefined {
  const value = Number(sample.value);
  const scale = SCALE[sample.unit ?? defaultUnit];
  if (sample.value.trim() === "" || !Number.isFinite(value) || scale === undefined) {
    return undefined;
  }
  return value * scale;
}

/**
 * The value of one measurand: the sample without a phase when there is one,
 * otherwise the phase values combined (`sum` for energy and power, the largest
 * for current). Samples with an unknown unit or a non-numeric value are skipped.
 */
function measurand(
  samples: readonly SampledValue[],
  name: string,
  defaultUnit: string,
  combine: "sum" | "max",
): number | null {
  // OCPP defaults the measurand to Energy.Active.Import.Register.
  const matching = samples.filter(
    (sample) => (sample.measurand ?? "Energy.Active.Import.Register") === name,
  );
  const total = matching.find((sample) => sample.phase === undefined);
  if (total !== undefined) {
    return numeric(total, defaultUnit) ?? null;
  }
  const phases = matching
    .filter((sample) => sample.phase === "L1" || sample.phase === "L2" || sample.phase === "L3")
    .map((sample) => numeric(sample, defaultUnit))
    .filter((value) => value !== undefined);
  if (phases.length === 0) {
    return null;
  }
  return combine === "sum" ? phases.reduce((sum, value) => sum + value, 0) : Math.max(...phases);
}

/**
 * Turns MeterValues (or StopTransaction transactionData) into stored samples:
 * energy in Wh, power in W and current in A, when present. MeterValue entries
 * with none of the three are dropped.
 */
export function extractMeterSamples(meterValues: readonly MeterValue[]): MeterSample[] {
  const samples: MeterSample[] = [];
  for (const meterValue of meterValues) {
    const energy = measurand(meterValue.sampledValue, "Energy.Active.Import.Register", "Wh", "sum");
    const power = measurand(meterValue.sampledValue, "Power.Active.Import", "W", "sum");
    const current = measurand(meterValue.sampledValue, "Current.Import", "A", "max");
    if (energy === null && power === null && current === null) {
      continue;
    }
    samples.push({
      ts: new Date(meterValue.timestamp),
      energyWh: energy === null ? null : Math.round(energy),
      powerW: power === null ? null : Math.round(power),
      currentA: current === null ? null : Math.round(current * 100) / 100,
    });
  }
  return samples;
}
