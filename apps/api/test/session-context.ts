import type { Session } from "@nd/db";

import type { SessionContext } from "../src/data/sessions.ts";
import { DEFAULT_SESSION_TIMINGS, type SessionServices } from "../src/sessions/services.ts";
import { BOOKING_ID, bookingDetail, CHARGER_ID, HOST_USER_ID } from "./booking-detail.ts";
import { scriptedChargerControl } from "./fakes.ts";
import { unitServices } from "./services.ts";

export const DRIVER_ID = "user-cian";
export const SESSION_ID = "44444444-4444-4444-8444-444444444444";
/** 2027-01-12 22:10 UTC: ten minutes into the booking's slot. */
export const IN_SLOT = new Date("2027-01-12T22:10:00Z");

/** A session row for unit tests. */
export function session(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    bookingId: BOOKING_ID,
    ocppTransactionId: null,
    meterStartWh: null,
    meterStopWh: null,
    kwh: null,
    startedAt: null,
    stoppedAt: null,
    stopReason: null,
    status: "starting",
    createdAt: new Date("2027-01-12T22:05:00Z"),
    updatedAt: new Date("2027-01-12T22:05:00Z"),
    ...overrides,
  };
}

/**
 * The session context of the 4-hour booking from 22:00 UTC on 2027-01-12
 * (arrived, by default), with no session yet.
 */
export function sessionContext(
  overrides: {
    booking?: Partial<SessionContext["booking"]>;
    session?: Partial<Session> | null;
    meter?: SessionContext["meter"];
  } = {},
): SessionContext {
  const { booking } = bookingDetail(DRIVER_ID, {
    booking: {
      status: "arrived",
      arrivedAt: new Date("2027-01-12T21:55:00Z"),
      ...overrides.booking,
    },
  });
  return {
    booking,
    charger: { id: CHARGER_ID, chargeboxId: "NDTEST0001", location: { lat: 53.326, lng: -6.256 } },
    hostUserId: HOST_USER_ID,
    session:
      overrides.session === null || overrides.session === undefined
        ? null
        : session(overrides.session),
    meter: overrides.meter ?? null,
  };
}

/** Session services over fakes: scripted charger, in-memory jobs, recorded realtime calls. */
export function sessionServices(now: Date = IN_SLOT) {
  const base = unitServices(now);
  const control = scriptedChargerControl();
  const realtime = { booking: [] as string[], session: [] as string[] };
  const logged: { level: string; message: string }[] = [];
  const log = {
    info: (_details: object, message: string) => logged.push({ level: "info", message }),
    warn: (_details: object, message: string) => logged.push({ level: "warn", message }),
    error: (_details: object, message: string) => logged.push({ level: "error", message }),
  };
  const services: SessionServices = {
    ...base.services,
    log,
    chargerControl: control.control,
    sessionTimings: DEFAULT_SESSION_TIMINGS,
    realtime: {
      bookingChanged: (id) => realtime.booking.push(id),
      sessionChanged: (id) => realtime.session.push(id),
    },
  };
  return { ...base, services, control, realtime, logged };
}
