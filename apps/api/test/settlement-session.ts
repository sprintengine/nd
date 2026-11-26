import type { Session, SettlementSession } from "../src/data/settlement.ts";
import type { Services } from "../src/services.ts";
import type { SettlementServices } from "../src/settlement/services.ts";
import { BOOKING_ID, CHARGER_ID, HOST_USER_ID, payment } from "./booking-detail.ts";
import { unitServices } from "./services.ts";

export const SESSION_ID = "44444444-4444-4444-8444-444444444444";
export const HOST_ID = "55555555-5555-4555-8555-555555555555";

/** The slot of the fixture booking: 22:00 to 02:00 UTC, quoted at 1000 cents. */
export const SLOT = {
  start: new Date("2027-01-12T22:00:00Z"),
  end: new Date("2027-01-13T02:00:00Z"),
};

const minutesAfterStart = (minutes: number) => new Date(SLOT.start.getTime() + minutes * 60_000);

/** A session row: stopped after 3 h 39 min with 22.5 kWh delivered. */
export function sessionRow(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    bookingId: BOOKING_ID,
    ocppTransactionId: 7,
    meterStartWh: 1_000,
    meterStopWh: 23_500,
    kwh: 22.5,
    startedAt: SLOT.start,
    stoppedAt: minutesAfterStart(219),
    stopReason: "Remote",
    status: "stopped",
    reviewReason: null,
    confirmationDueAt: null,
    hostConfirmedAt: null,
    reconciledAt: null,
    createdAt: SLOT.start,
    updatedAt: SLOT.start,
    ...overrides,
  };
}

/** A stopped session with its booking (250 cents an hour, quote 1000), parties and authorised payment. */
export function settlementSession(
  overrides: {
    session?: Partial<Session>;
    payment?: Parameters<typeof payment>[0] | null;
    lastMeterValue?: { ts: Date; energyWh: number } | null;
    booking?: Partial<SettlementSession["booking"]>;
  } = {},
): SettlementSession {
  return {
    session: sessionRow(overrides.session),
    booking: {
      id: BOOKING_ID,
      status: "completed",
      slot: SLOT,
      driverId: "user-cian",
      quotedAmountCents: 1000,
      pricePerHourCents: 250,
      currency: "EUR",
      pluggedInAt: null,
      ...overrides.booking,
    },
    charger: { id: CHARGER_ID, timezone: "Europe/Dublin" },
    host: { id: HOST_ID, userId: HOST_USER_ID, name: "Niamh Byrne", email: "niamh@example.com" },
    driver: { name: "Cian Byrne", email: "cian@example.com" },
    payment: overrides.payment === null ? null : payment(overrides.payment),
    lastMeterValue:
      overrides.lastMeterValue === undefined
        ? { ts: minutesAfterStart(218), energyWh: 23_400 }
        : overrides.lastMeterValue,
  };
}

/** Unit services with a realtime feed that records what it was told. */
export function settlementServices(now: Date, overrides: Partial<Services> = {}) {
  const base = unitServices(now, overrides);
  const pushed: { kind: "booking" | "session"; bookingId: string }[] = [];
  const services: SettlementServices = {
    ...base.services,
    realtime: {
      bookingChanged: (bookingId) => {
        pushed.push({ kind: "booking", bookingId });
      },
      sessionChanged: (bookingId) => {
        pushed.push({ kind: "session", bookingId });
      },
    },
  };
  return { ...base, services, pushed };
}
