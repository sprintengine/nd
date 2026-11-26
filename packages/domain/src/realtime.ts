import { z } from "zod";

import { liveSessionStatusSchema, sessionFailureReasonSchema } from "./session-control.ts";
import { bookingStatusSchema, chargerStatusSchema, currencySchema } from "./status.ts";

// The realtime contract between the API's WebSocket at /ws and the apps.
// Messages are JSON text frames with a `type`. The server pushes changes to
// the users entitled to see them; a client fetches the full resource over
// REST when it needs more than a message carries. Version 1.

/** Path of the realtime WebSocket. */
export const REALTIME_PATH = "/ws";

/** Seconds between the server's WebSocket pings. A client that misses one pong is dropped. */
export const REALTIME_HEARTBEAT_SECONDS = 30;

const isoDateTime = z.iso.datetime({ offset: true });

/**
 * A booking's charging as the app shows it, for its driver or host. The same
 * shape is `GET /bookings/:id/session` and the body of `session:update`.
 */
export const sessionStateSchema = z
  .object({
    bookingId: z.uuid(),
    sessionId: z.uuid().nullable().describe("Null before the first start attempt"),
    status: liveSessionStatusSchema,
    kwh: z.number().nonnegative().nullable().describe("Energy delivered so far, in kWh"),
    kw: z.number().nonnegative().nullable().describe("Latest charging power, in kW"),
    elapsed: z.int().nonnegative().describe("Seconds billed so far"),
    costSoFar: z
      .int()
      .nonnegative()
      .describe(
        "Cost so far in cents: elapsed time rounded up to 5 minutes at the hourly price, capped at the quote",
      ),
    currency: currencySchema,
    lastSeenAt: isoDateTime
      .nullable()
      .describe("When the charger last reported on this session; the app shows its age"),
    startAt: isoDateTime
      .nullable()
      .describe("When charging started, or when a scheduled start will send the remote start"),
    stoppedAt: isoDateTime.nullable(),
    stopReason: z
      .string()
      .nullable()
      .describe("The charger's reason, such as Remote or EVDisconnected"),
    failure: z
      .object({ code: sessionFailureReasonSchema, message: z.string() })
      .nullable()
      .describe("Why the last start failed, with copy the app can show"),
  })
  .meta({ id: "SessionState" });
export type SessionState = z.infer<typeof sessionStateSchema>;

/** Sent once after the connection is accepted. */
const readyMessage = z.strictObject({
  type: z.literal("ready"),
  heartbeatSeconds: z.int().positive(),
});

/** A booking the user is driver or host of changed status. Fetch `GET /bookings/:id` for the rest. */
const bookingUpdateMessage = z.strictObject({
  type: z.literal("booking:update"),
  bookingId: z.uuid(),
  status: bookingStatusSchema,
  at: isoDateTime,
});

/** Live charging figures for a booking, to its driver and host; about once a minute while charging. */
const sessionUpdateMessage = sessionStateSchema
  .extend({ type: z.literal("session:update") })
  .strict();

/** One of the host's chargers changed state. Hosts only. */
const chargerStatusMessage = z.strictObject({
  type: z.literal("charger:status"),
  chargerId: z.uuid(),
  status: chargerStatusSchema,
  /** OCPP connector status from the latest StatusNotification, such as `Charging`. */
  connectorStatus: z.string().nullable(),
  /** OCPP error code; `NoError` when healthy. */
  errorCode: z.string().nullable(),
  at: isoDateTime,
});

/**
 * The server lost track of events (its database link reconnected). Refetch
 * whatever is on screen.
 */
const resyncMessage = z.strictObject({ type: z.literal("resync") });

/** The answer to a client's `ping`. */
const pongMessage = z.strictObject({ type: z.literal("pong") });

/** Every message the server sends. */
export const serverMessageSchema = z.discriminatedUnion("type", [
  readyMessage,
  bookingUpdateMessage,
  sessionUpdateMessage,
  chargerStatusMessage,
  resyncMessage,
  pongMessage,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ServerMessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

/**
 * Messages a client may send. Browsers cannot send WebSocket pings, so an
 * app-level `ping` is answered with `pong`. Anything else is ignored.
 */
export const clientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** Parses a client's text frame; undefined for anything that is not a known message. */
export function parseClientMessage(text: string): ClientMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = clientMessageSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
