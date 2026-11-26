import { beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_ID, bookingDetail, PAYMENT_ID } from "../../test/booking-detail.ts";
import { sessionRow, settlementServices, SLOT } from "../../test/settlement-session.ts";
import * as bookingData from "../data/bookings.ts";
import * as data from "../data/settlement.ts";
import { closeArrivedBooking } from "./arrivals.ts";

vi.mock("../data/bookings.ts");
vi.mock("../data/settlement.ts");

const AFTER = new Date(SLOT.end.getTime() + 11 * 60_000);
let env: ReturnType<typeof settlementServices>;

function arrived(overrides: Parameters<typeof bookingDetail>[1] = {}) {
  vi.mocked(bookingData.findBookingDetail).mockResolvedValue(
    bookingDetail("user-cian", {
      ...overrides,
      booking: { status: "arrived", slot: SLOT, ...overrides.booking },
    }),
  );
}

const bookingChanges = () =>
  vi.mocked(bookingData.updateBookingFrom).mock.calls.map((call) => call[3]);

beforeEach(() => {
  vi.resetAllMocks();
  env = settlementServices(AFTER);
  vi.mocked(bookingData.updateBookingFrom).mockResolvedValue(true);
  vi.mocked(bookingData.updatePaymentFrom).mockResolvedValue(true);
  vi.mocked(data.billedSessionOf).mockResolvedValue(undefined);
  vi.mocked(data.hasAnySession).mockResolvedValue(false);
});

describe("closeArrivedBooking", () => {
  it("applies the no-show rule when the driver never plugged in", async () => {
    arrived();
    await expect(closeArrivedBooking(env.services, BOOKING_ID)).resolves.toBe("no_show");
    expect(env.payments.callsTo("capture")).toEqual([
      expect.objectContaining({ input: expect.objectContaining({ amountCents: 250 }) as unknown }),
    ]);
    expect(env.jobs.sent).toEqual([
      expect.objectContaining({ name: "host-transfer", payload: { paymentId: PAYMENT_ID } }),
    ]);
    expect(bookingChanges()).toEqual([{ status: "no_show", cancellationFeeCents: 250 }]);
    expect(env.pushed).toEqual([{ kind: "booking", bookingId: BOOKING_ID }]);
  });

  it("charges nothing for a no-show without an authorisation", async () => {
    arrived({ payment: { status: "card_saved", stripePaymentIntentId: null } });
    await expect(closeArrivedBooking(env.services, BOOKING_ID)).resolves.toBe("no_show");
    expect(env.payments.callsTo("capture")).toEqual([]);
    expect(bookingChanges()).toEqual([{ status: "no_show", cancellationFeeCents: 0 }]);
  });

  it("completes with nothing billed when a start was tried or the car plugged in", async () => {
    arrived();
    vi.mocked(data.hasAnySession).mockResolvedValue(true);
    await expect(closeArrivedBooking(env.services, BOOKING_ID)).resolves.toBe("completed");
    arrived({ booking: { pluggedInAt: new Date(SLOT.start) } });
    await expect(closeArrivedBooking(env.services, BOOKING_ID)).resolves.toBe("completed");
    expect(env.payments.callsTo("capture")).toEqual([]);
    expect(env.payments.callsTo("cancelAuthorisation")).toHaveLength(2);
    expect(bookingChanges()).toEqual([{ status: "completed" }, { status: "completed" }]);
  });

  it("leaves other bookings, unfinished slots and started sessions alone", async () => {
    arrived({ booking: { status: "active" } });
    await expect(closeArrivedBooking(env.services, BOOKING_ID)).resolves.toBe("skipped");
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(undefined);
    await expect(closeArrivedBooking(env.services, BOOKING_ID)).resolves.toBe("skipped");
    arrived();
    env.clock.current = new Date(SLOT.end.getTime() + 9 * 60_000);
    await expect(closeArrivedBooking(env.services, BOOKING_ID)).resolves.toBe("skipped");
    env.clock.current = AFTER;
    vi.mocked(data.billedSessionOf).mockResolvedValue(sessionRow());
    await expect(closeArrivedBooking(env.services, BOOKING_ID)).resolves.toBe("skipped");
    expect(bookingData.updateBookingFrom).not.toHaveBeenCalled();
  });
});
