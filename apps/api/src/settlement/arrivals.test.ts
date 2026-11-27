import { beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_ID, bookingDetail, PAYMENT_ID } from "../../test/booking-detail.ts";
import { sessionRow, settlementServices, SLOT } from "../../test/settlement-session.ts";
import * as bookingData from "../data/bookings.ts";
import * as paymentData from "../data/payments.ts";
import * as data from "../data/settlement.ts";
import { closeArrivedBooking } from "./arrivals.ts";

vi.mock("../data/bookings.ts");
vi.mock("../data/settlement.ts");
vi.mock("../data/payments.ts");

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

const refund = {
  id: "refund-1",
  paymentId: PAYMENT_ID,
  amountCents: 1000,
  currency: "EUR" as const,
  reason: "charger_fault" as const,
  status: "pending" as const,
  stripeRefundId: null,
  issuedById: null,
  note: null,
  failureReason: null,
  createdAt: AFTER,
  updatedAt: AFTER,
};

beforeEach(() => {
  vi.resetAllMocks();
  env = settlementServices(AFTER);
  vi.mocked(bookingData.updateBookingFrom).mockResolvedValue(true);
  vi.mocked(data.billedSessionOf).mockResolvedValue(undefined);
  vi.mocked(data.startFailedAtCharger).mockResolvedValue(false);
  vi.mocked(paymentData.updateBookingWithRefund).mockResolvedValue({ changed: true, refund });
});

describe("closeArrivedBooking", () => {
  it("makes a driver who never plugged in at a working charger a no-show, not refunded", async () => {
    arrived();
    await expect(closeArrivedBooking(env.services, BOOKING_ID)).resolves.toBe("no_show");
    expect(bookingData.updateBookingFrom).toHaveBeenCalledWith(
      expect.anything(),
      BOOKING_ID,
      ["arrived"],
      { status: "no_show" },
    );
    expect(env.payments.calls).toEqual([]);
    expect(env.pushed).toEqual([{ kind: "booking", bookingId: BOOKING_ID }]);
  });

  it.each([
    [
      "a start failed at the charger",
      () => vi.mocked(data.startFailedAtCharger).mockResolvedValue(true),
    ],
    [
      "the charger is offline",
      () => {
        arrived({ charger: { status: "offline" } });
      },
    ],
  ])("refunds in full, automatically, when %s", async (_case, arrange) => {
    arrived();
    arrange();
    await expect(closeArrivedBooking(env.services, BOOKING_ID)).resolves.toBe("refunded");
    expect(paymentData.updateBookingWithRefund).toHaveBeenCalledWith(
      expect.anything(),
      BOOKING_ID,
      ["arrived"],
      { status: "completed" },
      { paymentId: PAYMENT_ID, amountCents: 1000, reason: "charger_fault" },
    );
    expect(env.payments.callsTo("refund")[0]?.input).toMatchObject({
      amountCents: 1000,
      idempotencyKey: "refund-refund-1",
    });
  });

  it("does not refund a driver who plugged in and stopped before charging began", async () => {
    arrived({ booking: { pluggedInAt: SLOT.start } });
    await expect(closeArrivedBooking(env.services, BOOKING_ID)).resolves.toBe("no_show");
    expect(data.startFailedAtCharger).toHaveBeenCalledWith(
      expect.anything(),
      BOOKING_ID,
      expect.any(String),
    );
    expect(paymentData.updateBookingWithRefund).not.toHaveBeenCalled();
  });

  it("resumes a refund Stripe did not answer", async () => {
    arrived({ charger: { status: "faulted" } });
    env.payments.state.refund = "error";
    await expect(closeArrivedBooking(env.services, BOOKING_ID)).resolves.toBe("refunded");
    expect(env.jobs.sent[0]).toMatchObject({ name: "resume-payment" });
  });

  it("refunds nothing that was not paid", async () => {
    arrived({ charger: { status: "offline" }, payment: { status: "pending" } });
    vi.mocked(paymentData.updateBookingWithRefund).mockResolvedValue({
      changed: true,
      refund: undefined,
    });
    await expect(closeArrivedBooking(env.services, BOOKING_ID)).resolves.toBe("refunded");
    expect(vi.mocked(paymentData.updateBookingWithRefund).mock.calls[0]?.[4]).toBeUndefined();
    expect(env.payments.calls).toEqual([]);
  });

  it("leaves other bookings, unfinished slots, started sessions and lost races alone", async () => {
    arrived({ booking: { status: "active" } });
    await expect(closeArrivedBooking(env.services, BOOKING_ID)).resolves.toBe("skipped");
    arrived();
    env.clock.current = new Date(SLOT.end.getTime() + 9 * 60_000);
    await expect(closeArrivedBooking(env.services, BOOKING_ID)).resolves.toBe("skipped");
    env.clock.current = AFTER;
    vi.mocked(data.billedSessionOf).mockResolvedValueOnce(sessionRow());
    await expect(closeArrivedBooking(env.services, BOOKING_ID)).resolves.toBe("skipped");
    arrived({ charger: { status: "offline" } });
    vi.mocked(paymentData.updateBookingWithRefund).mockResolvedValue({
      changed: false,
      refund: undefined,
    });
    await expect(closeArrivedBooking(env.services, BOOKING_ID)).resolves.toBe("skipped");
    expect(env.payments.calls).toEqual([]);
  });
});
