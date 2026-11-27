import { z } from "zod";

/**
 * Types shared by several OCPP 1.6 messages. Limits follow the OCPP 1.6 JSON
 * schemas: CiStringN is a case-insensitive string of at most N characters,
 * and every object rejects properties the schema does not define.
 */

/** A case-insensitive string of at most `max` characters (CiString20Type, ...). */
export const ciString = (max: number) => z.string().max(max);

/** IdToken: an identifier of at most 20 characters, such as an RFID uid or a booking tag. */
export const IdToken = ciString(20);
export type IdToken = z.infer<typeof IdToken>;

/** An RFC 3339 date-time with a time zone, as OCPP's `"format": "date-time"`. */
export const DateTime = z.iso.datetime({ offset: true });
export type DateTime = z.infer<typeof DateTime>;

/** A JSON integer. */
export const Integer = z.int();

export const AuthorizationStatus = z.enum([
  "Accepted",
  "Blocked",
  "Expired",
  "Invalid",
  "ConcurrentTx",
]);
export type AuthorizationStatus = z.infer<typeof AuthorizationStatus>;

export const IdTagInfo = z.strictObject({
  expiryDate: DateTime.optional(),
  parentIdTag: IdToken.optional(),
  status: AuthorizationStatus,
});
export type IdTagInfo = z.infer<typeof IdTagInfo>;

export const ReadingContext = z.enum([
  "Interruption.Begin",
  "Interruption.End",
  "Sample.Clock",
  "Sample.Periodic",
  "Transaction.Begin",
  "Transaction.End",
  "Trigger",
  "Other",
]);
export type ReadingContext = z.infer<typeof ReadingContext>;

export const ValueFormat = z.enum(["Raw", "SignedData"]);
export type ValueFormat = z.infer<typeof ValueFormat>;

export const Measurand = z.enum([
  "Energy.Active.Export.Register",
  "Energy.Active.Import.Register",
  "Energy.Reactive.Export.Register",
  "Energy.Reactive.Import.Register",
  "Energy.Active.Export.Interval",
  "Energy.Active.Import.Interval",
  "Energy.Reactive.Export.Interval",
  "Energy.Reactive.Import.Interval",
  "Power.Active.Export",
  "Power.Active.Import",
  "Power.Offered",
  "Power.Reactive.Export",
  "Power.Reactive.Import",
  "Power.Factor",
  "Current.Import",
  "Current.Export",
  "Current.Offered",
  "Voltage",
  "Frequency",
  "Temperature",
  "SoC",
  "RPM",
]);
export type Measurand = z.infer<typeof Measurand>;

export const Phase = z.enum([
  "L1",
  "L2",
  "L3",
  "N",
  "L1-N",
  "L2-N",
  "L3-N",
  "L1-L2",
  "L2-L3",
  "L3-L1",
]);
export type Phase = z.infer<typeof Phase>;

export const Location = z.enum(["Cable", "EV", "Inlet", "Outlet", "Body"]);
export type Location = z.infer<typeof Location>;

/**
 * UnitOfMeasure. The 1.6 JSON schema spells Celsius "Celcius"; the errata
 * add the correct spelling, so both are accepted.
 */
export const UnitOfMeasure = z.enum([
  "Wh",
  "kWh",
  "varh",
  "kvarh",
  "W",
  "kW",
  "VA",
  "kVA",
  "var",
  "kvar",
  "A",
  "V",
  "K",
  "Celcius",
  "Celsius",
  "Fahrenheit",
  "Percent",
]);
export type UnitOfMeasure = z.infer<typeof UnitOfMeasure>;

export const SampledValue = z.strictObject({
  value: z.string(),
  context: ReadingContext.optional(),
  format: ValueFormat.optional(),
  measurand: Measurand.optional(),
  phase: Phase.optional(),
  location: Location.optional(),
  unit: UnitOfMeasure.optional(),
});
export type SampledValue = z.infer<typeof SampledValue>;

export const MeterValue = z.strictObject({
  timestamp: DateTime,
  sampledValue: z.array(SampledValue),
});
export type MeterValue = z.infer<typeof MeterValue>;

export const ChargingProfilePurpose = z.enum([
  "ChargePointMaxProfile",
  "TxDefaultProfile",
  "TxProfile",
]);
export const ChargingProfileKind = z.enum(["Absolute", "Recurring", "Relative"]);
export const RecurrencyKind = z.enum(["Daily", "Weekly"]);
export const ChargingRateUnit = z.enum(["A", "W"]);

export const ChargingSchedulePeriod = z.strictObject({
  startPeriod: Integer,
  limit: z.number().multipleOf(0.1),
  numberPhases: Integer.optional(),
});

export const ChargingSchedule = z.strictObject({
  duration: Integer.optional(),
  startSchedule: DateTime.optional(),
  chargingRateUnit: ChargingRateUnit,
  chargingSchedulePeriod: z.array(ChargingSchedulePeriod),
  minChargingRate: z.number().multipleOf(0.1).optional(),
});

/** csChargingProfiles, as carried by RemoteStartTransaction. */
export const ChargingProfile = z.strictObject({
  chargingProfileId: Integer,
  transactionId: Integer.optional(),
  stackLevel: Integer,
  chargingProfilePurpose: ChargingProfilePurpose,
  chargingProfileKind: ChargingProfileKind,
  recurrencyKind: RecurrencyKind.optional(),
  validFrom: DateTime.optional(),
  validTo: DateTime.optional(),
  chargingSchedule: ChargingSchedule,
});
export type ChargingProfile = z.infer<typeof ChargingProfile>;
