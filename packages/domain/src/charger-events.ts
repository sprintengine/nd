import { z } from "zod";

import { sessionStatusSchema } from "./status.ts";

// Events the OCPP gateway publishes to the API with Postgres NOTIFY. The rows
// an event refers to are written in the same transaction as the NOTIFY, so a
// listener that receives one can read them. NOTIFY is not durable: a listener
// that reconnects must catch up from the tables.

/** Postgres channel the gateway publishes charger events on. */
export const CHARGER_EVENTS_CHANNEL = "charger_events";

/** Version of the event payload. Bump it for any incompatible change. */
export const CHARGER_EVENT_VERSION = 1;

/** Every event type, in the order a charger usually produces them. */
export const CHARGER_EVENT_TYPES = [
  "boot",
  "status",
  "fault",
  "offline",
  "online",
  "session_started",
  "meter",
  "session_stopped",
] as const;
export type ChargerEventType = (typeof CHARGER_EVENT_TYPES)[number];

const isoDateTime = z.iso.datetime({ offset: true });

const base = {
  v: z.literal(CHARGER_EVENT_VERSION),
  /** When the gateway recorded the event. */
  at: isoDateTime,
  chargerId: z.uuid(),
  chargeboxId: z.string().min(1),
};

const connectorId = z.int().nonnegative();
const transactionId = z.int();

/** The charger sent BootNotification and is online. */
const bootEvent = z.strictObject({
  ...base,
  type: z.literal("boot"),
  firmware: z.string().nullable(),
});

/** A StatusNotification. `session*` are set when it changed an open session's status. */
const statusEvent = z.strictObject({
  ...base,
  type: z.literal("status"),
  connectorId,
  /** OCPP ChargePointStatus, such as `Preparing` or `SuspendedEV`. */
  status: z.string().min(1),
  /** OCPP ChargePointErrorCode; `NoError` when healthy. */
  errorCode: z.string().min(1),
  sessionId: z.uuid().optional(),
  sessionStatus: sessionStatusSchema.optional(),
});

/** A StatusNotification with an error code other than NoError: the charger is `faulted`. */
const faultEvent = z.strictObject({
  ...base,
  type: z.literal("fault"),
  connectorId,
  errorCode: z.string().min(1),
  info: z.string().optional(),
  vendorErrorCode: z.string().optional(),
});

/** No heartbeat for three intervals: the charger is `offline`. */
const offlineEvent = z.strictObject({
  ...base,
  type: z.literal("offline"),
  lastHeartbeatAt: isoDateTime.nullable(),
});

/** An offline charger heartbeated again without rebooting. */
const onlineEvent = z.strictObject({
  ...base,
  type: z.literal("online"),
});

/** StartTransaction for a booking: the session is `charging` and the booking `active`. */
const sessionStartedEvent = z.strictObject({
  ...base,
  type: z.literal("session_started"),
  sessionId: z.uuid(),
  bookingId: z.uuid(),
  transactionId,
  meterStartWh: z.int(),
});

/** MeterValues stored for a session. The rows are in `meter_values`. */
const meterEvent = z.strictObject({
  ...base,
  type: z.literal("meter"),
  sessionId: z.uuid(),
  transactionId: transactionId.nullable(),
  /** Timestamp of the latest sample. */
  ts: isoDateTime,
  energyWh: z.int().nullable(),
  powerW: z.int().nullable(),
});

/**
 * StopTransaction for a booking session: the session is `stopped` (or
 * `needs_review` when the meter went backwards) and the booking `completed`.
 * The API enqueues reconciliation on this event.
 */
const sessionStoppedEvent = z.strictObject({
  ...base,
  type: z.literal("session_stopped"),
  sessionId: z.uuid(),
  bookingId: z.uuid(),
  transactionId,
  sessionStatus: sessionStatusSchema,
  meterStopWh: z.int(),
  kwh: z.number().nonnegative().nullable(),
  reason: z.string().nullable(),
});

/** One event on {@link CHARGER_EVENTS_CHANNEL}. */
export const chargerEventSchema = z.discriminatedUnion("type", [
  bootEvent,
  statusEvent,
  faultEvent,
  offlineEvent,
  onlineEvent,
  sessionStartedEvent,
  meterEvent,
  sessionStoppedEvent,
]);
export type ChargerEvent = z.infer<typeof chargerEventSchema>;
export type ChargerEventOf<T extends ChargerEventType> = Extract<ChargerEvent, { type: T }>;

/**
 * Parses a NOTIFY payload. Returns undefined for anything that is not a valid
 * event of this version, so a listener can skip it (and log) without throwing.
 */
export function parseChargerEvent(payload: string | undefined): ChargerEvent | undefined {
  if (payload === undefined) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const result = chargerEventSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
