import { beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_ID, bookingDetail, PAYMENT_ID } from "../../test/booking-detail.ts";
import { unitServices } from "../../test/services.ts";
import * as data from "../data/bookings.ts";
import {
  authoriseBookingJob,
  BOOKING_JOBS,
  expireRequestJob,
  hostTransferJob,
  noShowJob,
} from "./jobs.ts";

vi.mock("../data/bookings.ts");

const DRIVER = "user-cian";
const attempt = (retryCount: number, lastAttempt = false) => ({
  jobId: "j1",
  retryCount,
  lastAttempt,
});

let env: ReturnType<typeof unitServices>;

beforeEach(() => {
  vi.resetAllMocks();
  env = unitServices(new Date("2027-01-11T22:00:00Z"));
  vi.mocked(data.updatePaymentFrom).mockResolvedValue(true);
  vi.mocked(data.updateBookingFrom).mockResolvedValue(true);
});

const savedCard = (overrides: Parameters<typeof bookingDetail>[1] = {}) =>
  vi.mocked(data.findBookingDetail).mockResolvedValue(
    bookingDetail(DRIVER, {
      ...overrides,
      payment: {
        status: "card_saved",
        stripePaymentIntentId: null,
        authorisedCents: 0,
        ...overrides.payment,
      },
    }),
  );

describe("BOOKING_JOBS", () => {
  it("lists every job once", () => {
    expect(BOOKING_JOBS.map((job) => job.name)).toEqual([
      "authorise-booking",
      "booking-no-show",
      "booking-expire-request",
      "host-transfer",
    ]);
  });
});

describe("authorise-booking", () => {
  it("authorises the saved card with a key per attempt", async () => {
    savedCard();
    await authoriseBookingJob.run({ bookingId: BOOKING_ID }, env.services, attempt(1));
    expect(env.payments.callsTo("authorise")[0]?.input).toMatchObject({
      amountCents: 1000,
      customerId: "cus_1",
      paymentMethodId: "pm_card_visa",
      idempotencyKey: `booking-${BOOKING_ID}-authorise-1`,
    });
    expect(data.updatePaymentFrom).toHaveBeenCalledWith(
      expect.anything(),
      PAYMENT_ID,
      ["card_saved"],
      {
        status: "authorised",
        stripePaymentIntentId: "pi_1",
        authorisedCents: 1000,
        failureReason: null,
      },
    );
  });

  it("does nothing for a booking that is gone, cancelled or already authorised", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(undefined);
    await authoriseBookingJob.run({ bookingId: BOOKING_ID }, env.services, attempt(0));
    savedCard({ booking: { status: "cancelled" } });
    await authoriseBookingJob.run({ bookingId: BOOKING_ID }, env.services, attempt(0));
    vi.mocked(data.findBookingDetail).mockResolvedValue(bookingDetail(DRIVER));
    await authoriseBookingJob.run({ bookingId: BOOKING_ID }, env.services, attempt(0));
    vi.mocked(data.findBookingDetail).mockResolvedValue(bookingDetail(DRIVER, { payment: null }));
    await authoriseBookingJob.run({ bookingId: BOOKING_ID }, env.services, attempt(0));
    expect(env.payments.calls).toHaveLength(0);
  });

  it("records a decline and retries", async () => {
    savedCard();
    env.payments.state.authorisation = { status: "failed", reason: "insufficient_funds" };
    await expect(
      authoriseBookingJob.run({ bookingId: BOOKING_ID }, env.services, attempt(0)),
    ).rejects.toThrow(/insufficient_funds/);
    expect(data.updatePaymentFrom).toHaveBeenCalledWith(
      expect.anything(),
      PAYMENT_ID,
      ["card_saved"],
      {
        failureReason: "insufficient_funds",
      },
    );
    expect(data.updateBookingFrom).not.toHaveBeenCalled();
  });

  it("cancels the booking at no charge after the last attempt", async () => {
    savedCard();
    env.payments.state.authorisation = { status: "failed", reason: "expired_card" };
    await authoriseBookingJob.run({ bookingId: BOOKING_ID }, env.services, attempt(4, true));
    expect(data.updateBookingFrom).toHaveBeenCalledWith(
      expect.anything(),
      BOOKING_ID,
      ["requested", "confirmed"],
      expect.objectContaining({
        status: "cancelled",
        cancelledBy: "system",
        cancellationReason: "payment_failed: expired_card",
      }),
    );
  });

  it("retries provider errors, and gives up on the last attempt", async () => {
    savedCard();
    env.payments.state.authorisation = { status: "error" };
    await expect(
      authoriseBookingJob.run({ bookingId: BOOKING_ID }, env.services, attempt(0)),
    ).rejects.toThrow("network down");
    await authoriseBookingJob.run({ bookingId: BOOKING_ID }, env.services, attempt(4, true));
    expect(vi.mocked(data.updateBookingFrom).mock.calls[0]?.[3]).toMatchObject({
      cancellationReason: "payment_failed: provider_error",
    });
  });

  it("cancels when there is no saved card to use", async () => {
    savedCard({ driver: { stripeCustomerId: null } });
    await authoriseBookingJob.run({ bookingId: BOOKING_ID }, env.services, attempt(0));
    expect(vi.mocked(data.updatePaymentFrom).mock.calls[0]?.[3]).toEqual({
      status: "failed",
      failureReason: "no_saved_card",
    });
  });
});

describe("booking-no-show", () => {
  const end = new Date("2027-01-13T02:00:00Z");

  it("waits until 15 minutes after the slot", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(bookingDetail(DRIVER));
    env.clock.current = new Date(end.getTime() + 14 * 60_000);
    await noShowJob.run({ bookingId: BOOKING_ID }, env.services, attempt(0));
    expect(data.updateBookingFrom).not.toHaveBeenCalled();
  });

  it("captures the no-show fee and queues the host's transfer", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(bookingDetail(DRIVER));
    env.clock.current = new Date(end.getTime() + 15 * 60_000);
    await noShowJob.run({ bookingId: BOOKING_ID }, env.services, attempt(0));
    expect(env.payments.callsTo("capture")[0]?.input).toMatchObject({ amountCents: 250 });
    expect(data.updateBookingFrom).toHaveBeenCalledWith(
      expect.anything(),
      BOOKING_ID,
      ["confirmed"],
      {
        status: "no_show",
        cancellationFeeCents: 250,
      },
    );
    expect(env.jobs.sent[0]?.name).toBe("host-transfer");
  });

  it("releases a card that was never authorised, charging nothing", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail(DRIVER, { payment: { status: "card_saved", stripePaymentIntentId: null } }),
    );
    env.clock.current = new Date(end.getTime() + 20 * 60_000);
    await noShowJob.run({ bookingId: BOOKING_ID }, env.services, attempt(0));
    expect(env.payments.callsTo("capture")).toHaveLength(0);
    expect(vi.mocked(data.updateBookingFrom).mock.calls[0]?.[3]).toMatchObject({
      cancellationFeeCents: 0,
    });
  });

  it("leaves bookings that were not left confirmed", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail(DRIVER, { booking: { status: "completed" } }),
    );
    await noShowJob.run({ bookingId: BOOKING_ID }, env.services, attempt(0));
    expect(data.updateBookingFrom).not.toHaveBeenCalled();
  });
});

describe("booking-expire-request", () => {
  it("cancels an unanswered request once the slot starts", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail(DRIVER, { booking: { status: "requested", idTag: null } }),
    );
    await expireRequestJob.run({ bookingId: BOOKING_ID }, env.services, attempt(0));
    expect(data.updateBookingFrom).not.toHaveBeenCalled();
    env.clock.current = new Date("2027-01-12T22:00:00Z");
    await expireRequestJob.run({ bookingId: BOOKING_ID }, env.services, attempt(0));
    expect(env.payments.callsTo("cancelAuthorisation")).toHaveLength(1);
    expect(vi.mocked(data.updateBookingFrom).mock.calls[0]?.[3]).toMatchObject({
      status: "cancelled",
      cancelledBy: "system",
      cancellationReason: "host_did_not_respond",
    });
  });

  it("leaves answered requests alone", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(bookingDetail(DRIVER));
    await expireRequestJob.run({ bookingId: BOOKING_ID }, env.services, attempt(0));
    expect(data.updateBookingFrom).not.toHaveBeenCalled();
  });
});

describe("host-transfer", () => {
  it("sends or holds the transfer", async () => {
    vi.mocked(data.findPayment).mockResolvedValue(undefined);
    await expect(
      hostTransferJob.run({ paymentId: PAYMENT_ID }, env.services, attempt(0)),
    ).rejects.toThrow(/no payment/);
  });
});
