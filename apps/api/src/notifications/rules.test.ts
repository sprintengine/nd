import { NOTIFICATION_KINDS, pushDataSchema } from "@nd/domain";
import { describe, expect, it } from "vitest";

import {
  type BookingFacts,
  formatKwh,
  formatMoney,
  formatSlot,
  messageFor,
  offlineSpellContinues,
  planNotifications,
} from "./rules.ts";

const BOOKING_ID = "11111111-1111-4111-8111-111111111111";
const CHARGER_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";

const booking = (overrides: Partial<BookingFacts> = {}): BookingFacts => ({
  id: BOOKING_ID,
  chargerId: CHARGER_ID,
  status: "requested",
  slot: { start: new Date("2027-01-12T22:00:00Z"), end: new Date("2027-01-13T07:00:00Z") },
  cancelledBy: null,
  driverId: "user-driver",
  hostUserId: "user-host",
  timezone: "Europe/Dublin",
  ...overrides,
});

const plan = (trigger: Parameters<typeof planNotifications>[0], facts = {}) =>
  planNotifications(trigger, facts).map(({ userId, kind, eventKey }) => ({
    userId,
    kind,
    eventKey,
  }));

describe("formatting", () => {
  it("shows the slot in the charger's time zone, money in its currency and kWh to one place", () => {
    expect(formatSlot(booking().slot, "Europe/Dublin")).toBe("Tue 12 Jan, 22:00–07:00");
    expect(formatSlot(booking().slot, "Europe/Paris")).toBe("Tue 12 Jan, 23:00–08:00");
    expect(formatMoney(1250, "EUR")).toBe("€12.50");
    expect(formatMoney(900, "GBP")).toBe("£9.00");
    expect(formatKwh(8.456)).toBe("8.5 kWh");
  });
});

describe("planNotifications", () => {
  it("tells the host about a new request, or a new instant booking", () => {
    const trigger = { type: "booking_created", bookingId: BOOKING_ID } as const;
    expect(plan(trigger, { booking: booking() })).toEqual([
      {
        userId: "user-host",
        kind: "booking_requested",
        eventKey: `booking:${BOOKING_ID}:booking_requested`,
      },
    ]);
    expect(plan(trigger, { booking: booking({ status: "confirmed" }) })[0]?.kind).toBe(
      "booking_received",
    );
    expect(plan(trigger, { booking: booking({ status: "cancelled" }) })).toEqual([]);
  });

  it("tells the driver about answers to a request", () => {
    for (const type of ["booking_approved", "booking_declined", "booking_expired"] as const) {
      expect(plan({ type, bookingId: BOOKING_ID }, { booking: booking() })).toEqual([
        { userId: "user-driver", kind: type, eventKey: `booking:${BOOKING_ID}:${type}` },
      ]);
    }
  });

  it("tells the other side about a cancellation", () => {
    const trigger = { type: "booking_cancelled", bookingId: BOOKING_ID } as const;
    const cancelled = (by: BookingFacts["cancelledBy"]) =>
      plan(trigger, { booking: booking({ status: "cancelled", cancelledBy: by }) });
    expect(cancelled("driver")).toEqual([
      expect.objectContaining({ userId: "user-host", kind: "booking_cancelled_by_driver" }),
    ]);
    expect(cancelled("host")).toEqual([
      expect.objectContaining({ userId: "user-driver", kind: "booking_cancelled" }),
    ]);
    expect(cancelled("system")).toEqual([
      expect.objectContaining({ userId: "user-driver", kind: "booking_cancelled" }),
    ]);
    expect(plan(trigger, { booking: booking({ status: "confirmed" }) })).toEqual([]);
  });

  it("tells the host and driver about the session", () => {
    const ids = { bookingId: BOOKING_ID, sessionId: SESSION_ID };
    const facts = { booking: booking({ status: "active" }) };
    expect(plan({ type: "guest_arrived", bookingId: BOOKING_ID }, facts)).toEqual([
      expect.objectContaining({ userId: "user-host", kind: "guest_arrived" }),
    ]);
    expect(plan({ type: "session_started", ...ids }, facts)).toEqual([
      expect.objectContaining({ userId: "user-driver", kind: "charging_started" }),
      expect.objectContaining({ userId: "user-host", kind: "session_started" }),
    ]);
    expect(plan({ type: "session_stopped", ...ids }, facts)).toEqual([
      expect.objectContaining({ userId: "user-driver", kind: "charging_stopped" }),
    ]);
    expect(plan({ type: "start_failed", ...ids }, facts)).toEqual([
      expect.objectContaining({ userId: "user-driver", kind: "start_failed" }),
    ]);
    // Settled and the fallback share one ledger key, so the host hears once.
    const settled = plan({ type: "session_settled", ...ids }, facts);
    const ended = plan({ type: "session_ended", ...ids }, facts);
    expect(settled).toEqual(ended);
    expect(settled).toEqual([
      {
        userId: "user-host",
        kind: "session_ended",
        eventKey: `session:${SESSION_ID}:session_ended`,
      },
    ]);
  });

  it("tells the host about their charger, and nobody when there is nothing to go on", () => {
    expect(
      plan(
        {
          type: "charger_faulted",
          chargerId: CHARGER_ID,
          errorCode: "GroundFailure",
          at: "2027-01-12T22:00:00.000Z",
        },
        { chargerHostUserId: "user-host" },
      ),
    ).toEqual([expect.objectContaining({ userId: "user-host", kind: "charger_faulted" })]);
    expect(
      plan({ type: "charger_offline", chargerId: CHARGER_ID, lastHeartbeatAt: null }, {}),
    ).toEqual([]);
    expect(plan({ type: "guest_arrived", bookingId: BOOKING_ID }, {})).toEqual([]);
  });
});

describe("messageFor", () => {
  it("writes every kind with only ids in its data", () => {
    for (const kind of NOTIFICATION_KINDS) {
      const message = messageFor(kind, { booking: booking(), chargerId: CHARGER_ID });
      expect(message.title.length).toBeGreaterThan(0);
      expect(message.body.length).toBeGreaterThan(0);
      expect(pushDataSchema.parse(message.data)).toEqual(message.data);
      expect(message.data.kind).toBe(kind);
      expect(message.body).not.toContain("user-");
    }
  });

  it("says what was billed and earned once settled, and only that it ended before", () => {
    const facts = { booking: booking({ status: "completed" }), kwh: 8.43 };
    const settled = { billedCents: 1875, earningsCents: 1875, currency: "EUR" };
    expect(messageFor("session_ended", { ...facts, settled }).body).toBe(
      "Your guest was billed €18.75 for 8.4 kWh. You earn €18.75.",
    );
    expect(
      messageFor("session_ended", {
        booking: booking(),
        kwh: null,
        settled: { ...settled, earningsCents: 1700 },
      }).body,
    ).toBe("Your guest was billed €18.75. You earn €17.00.");
    expect(messageFor("session_ended", facts).body).toBe(
      "Your guest's session has ended (8.4 kWh). Your earnings show once it is settled.",
    );
    expect(messageFor("session_ended", { booking: booking(), kwh: null }).body).toContain(
      "has ended. Your earnings",
    );
  });

  it("explains failures, faults and cancellations", () => {
    expect(messageFor("start_failed", { failureReason: "rejected" }).body).toContain(
      "wouldn't start",
    );
    expect(messageFor("start_failed", { failureReason: "odd" }).body).toContain("didn't respond");
    expect(messageFor("charger_faulted", { errorCode: "GroundFailure" }).body).toContain(
      "(GroundFailure)",
    );
    expect(messageFor("charger_faulted", {}).body).toBe(
      "Your charger reported a fault. It can't charge until it clears.",
    );
    expect(
      messageFor("booking_cancelled", { booking: booking({ cancelledBy: "host" }) }).body,
    ).toBe("The host cancelled Tue 12 Jan, 22:00–07:00.");
    expect(
      messageFor("booking_cancelled", { booking: booking({ cancelledBy: "system" }) }).body,
    ).toContain("payment could not be taken");
    expect(messageFor("charging_stopped", { kwh: 3 }).body).toBe(
      "Your session has ended: 3.0 kWh.",
    );
    expect(messageFor("booking_approved", {}).body).toBe("The host approved your booking.");
  });
});

describe("offlineSpellContinues", () => {
  const spell = "2027-01-12T22:00:00.000Z";
  it("holds while the charger stays offline without a newer heartbeat", () => {
    const lastHeartbeatAt = new Date(spell);
    expect(offlineSpellContinues(spell, { status: "offline", lastHeartbeatAt })).toBe(true);
    expect(offlineSpellContinues(null, { status: "offline", lastHeartbeatAt })).toBe(true);
    expect(offlineSpellContinues(spell, { status: "online", lastHeartbeatAt })).toBe(false);
    expect(
      offlineSpellContinues(spell, {
        status: "offline",
        lastHeartbeatAt: new Date("2027-01-12T22:30:00Z"),
      }),
    ).toBe(false);
  });
});
