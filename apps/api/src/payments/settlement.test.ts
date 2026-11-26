import { beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_ID, bookingDetail, payment, PAYMENT_ID } from "../../test/booking-detail.ts";
import { unitServices } from "../../test/services.ts";
import * as data from "../data/bookings.ts";
import {
  captureForBooking,
  createHostTransfer,
  PaymentStateError,
  releaseCardHold,
  transferHoldReason,
} from "./settlement.ts";

vi.mock("../data/bookings.ts");

let env: ReturnType<typeof unitServices>;

const context = (overrides: Partial<data.TransferContext> = {}): data.TransferContext => ({
  bookingId: BOOKING_ID,
  stripeAccountId: "acct_1",
  payoutStatus: "enabled",
  taxDetailsComplete: true,
  sessionStatus: "reconciled",
  disputeOpen: false,
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  env = unitServices(new Date("2027-01-13T09:00:00Z"), { platformFeeBps: 1000 });
  vi.mocked(data.findBookingDetail).mockResolvedValue(bookingDetail("user-cian"));
  vi.mocked(data.updatePaymentFrom).mockResolvedValue(true);
  vi.mocked(data.saveTransfer).mockImplementation((_db, paymentId, values) =>
    Promise.resolve({
      id: "t1",
      paymentId,
      stripeTransferId: values.stripeTransferId ?? null,
      sentAt: values.sentAt ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...values,
    }),
  );
});

describe("captureForBooking", () => {
  it("captures part of the authorisation and records the platform fee", async () => {
    await expect(captureForBooking(env.services, BOOKING_ID, 600)).resolves.toEqual({
      paymentId: PAYMENT_ID,
      capturedCents: 600,
      chargeId: "ch_pi_1",
    });
    expect(data.updatePaymentFrom).toHaveBeenCalledWith(
      expect.anything(),
      PAYMENT_ID,
      ["authorised"],
      {
        status: "captured",
        capturedCents: 600,
        stripeChargeId: "ch_pi_1",
        platformFeeCents: 60,
      },
    );
  });

  it("never captures more than was authorised", async () => {
    await expect(captureForBooking(env.services, BOOKING_ID, 1001)).rejects.toThrow(RangeError);
    await expect(captureForBooking(env.services, BOOKING_ID, -1)).rejects.toThrow(RangeError);
    await expect(captureForBooking(env.services, BOOKING_ID, 1.5)).rejects.toThrow(RangeError);
    expect(env.payments.callsTo("capture")).toHaveLength(0);
  });

  it("releases the authorisation when there is nothing to capture", async () => {
    await expect(captureForBooking(env.services, BOOKING_ID, 0)).resolves.toMatchObject({
      capturedCents: 0,
      chargeId: null,
    });
    expect(env.payments.callsTo("cancelAuthorisation")).toHaveLength(1);
  });

  it("returns an earlier capture of the same amount, and refuses another", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail("user-cian", {
        payment: { status: "captured", capturedCents: 600, stripeChargeId: "ch_1" },
      }),
    );
    await expect(captureForBooking(env.services, BOOKING_ID, 600)).resolves.toEqual({
      paymentId: PAYMENT_ID,
      capturedCents: 600,
      chargeId: "ch_1",
    });
    await expect(captureForBooking(env.services, BOOKING_ID, 700)).rejects.toThrow(
      PaymentStateError,
    );
  });

  it("only releases a hold that the stored payment says is still authorised", async () => {
    // 0 is the caller's choice (support may waive a session), but whether a
    // hold is released depends on the payment row alone.
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail("user-cian", {
        payment: { status: "captured", capturedCents: 600, stripeChargeId: "ch_1" },
      }),
    );
    await expect(captureForBooking(env.services, BOOKING_ID, 0)).rejects.toThrow(PaymentStateError);
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail("user-cian", { payment: { status: "card_saved" } }),
    );
    await expect(captureForBooking(env.services, BOOKING_ID, 0)).rejects.toThrow(
      /no authorisation/,
    );
    expect(env.payments.callsTo("cancelAuthorisation")).toHaveLength(0);
    expect(data.updatePaymentFrom).not.toHaveBeenCalled();
  });

  it("needs an authorised payment", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail("user-cian", { payment: null }),
    );
    await expect(captureForBooking(env.services, BOOKING_ID, 1)).rejects.toThrow(/no payment/);
    vi.mocked(data.findBookingDetail).mockResolvedValue(undefined);
    await expect(captureForBooking(env.services, BOOKING_ID, 1)).rejects.toThrow(/no payment/);
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail("user-cian", { payment: { status: "card_saved" } }),
    );
    await expect(captureForBooking(env.services, BOOKING_ID, 1)).rejects.toThrow(
      /no authorisation/,
    );
  });
});

describe("releaseCardHold", () => {
  it("cancels a held authorisation and marks the payment cancelled", async () => {
    await releaseCardHold(env.services, BOOKING_ID, payment());
    expect(env.payments.callsTo("cancelAuthorisation")).toHaveLength(1);
    expect(data.updatePaymentFrom).toHaveBeenCalledWith(
      expect.anything(),
      PAYMENT_ID,
      ["pending_authorisation", "card_saved", "authorised"],
      { status: "cancelled" },
    );
  });

  it("only marks a saved card cancelled, and ignores a missing payment", async () => {
    await releaseCardHold(env.services, BOOKING_ID, payment({ status: "card_saved" }));
    await releaseCardHold(env.services, BOOKING_ID, null);
    expect(env.payments.callsTo("cancelAuthorisation")).toHaveLength(0);
    expect(data.updatePaymentFrom).toHaveBeenCalledTimes(1);
  });
});

describe("transferHoldReason", () => {
  it.each([
    [{ sessionStatus: "needs_review" }, "session_needs_review"],
    [{ sessionStatus: "needs_host_confirmation" }, "session_needs_review"],
    [{ sessionStatus: "charging" }, "session_needs_review"],
    [{ disputeOpen: true }, "dispute_open"],
    [{ taxDetailsComplete: false }, "tax_details_incomplete"],
    [{ payoutStatus: "restricted" }, "payouts_not_enabled"],
    [{ stripeAccountId: null }, "payouts_not_enabled"],
    [{}, undefined],
    [{ sessionStatus: null }, undefined],
  ] as const)("holds %j for %s", (overrides, reason) => {
    expect(transferHoldReason(context(overrides))).toBe(reason);
  });
});

describe("createHostTransfer", () => {
  const captured = (overrides = {}) =>
    payment({
      status: "captured",
      capturedCents: 1000,
      platformFeeCents: 100,
      stripeChargeId: "ch_1",
      ...overrides,
    });

  it("sends the capture less the platform fee from the charge", async () => {
    vi.mocked(data.findPayment).mockResolvedValue(captured());
    vi.mocked(data.findTransferContext).mockResolvedValue(context());
    const transfer = await createHostTransfer(env.services, PAYMENT_ID);
    expect(transfer).toMatchObject({ status: "sent", amountCents: 900, stripeTransferId: "tr_1" });
    expect(env.payments.callsTo("transfer")[0]?.input).toEqual({
      amountCents: 900,
      currency: "EUR",
      destination: "acct_1",
      sourceTransaction: "ch_1",
      transferGroup: BOOKING_ID,
      metadata: { bookingId: BOOKING_ID, paymentId: PAYMENT_ID },
      idempotencyKey: `booking-${BOOKING_ID}-transfer`,
    });
  });

  it("holds it while the host's tax details are incomplete", async () => {
    vi.mocked(data.findPayment).mockResolvedValue(captured());
    vi.mocked(data.findTransferContext).mockResolvedValue(context({ taxDetailsComplete: false }));
    expect(await createHostTransfer(env.services, PAYMENT_ID)).toMatchObject({
      status: "held",
      holdReason: "tax_details_incomplete",
    });
    expect(env.payments.callsTo("transfer")).toHaveLength(0);
  });

  it("returns a sent transfer as it is", async () => {
    vi.mocked(data.findPayment).mockResolvedValue(captured());
    const sent = { status: "sent" } as data.Transfer;
    vi.mocked(data.findTransfer).mockResolvedValue(sent);
    expect(await createHostTransfer(env.services, PAYMENT_ID)).toBe(sent);
  });

  it("records a zero transfer without calling Stripe", async () => {
    vi.mocked(data.findPayment).mockResolvedValue(captured({ capturedCents: 100 }));
    vi.mocked(data.findTransferContext).mockResolvedValue(context());
    expect(await createHostTransfer(env.services, PAYMENT_ID)).toMatchObject({
      status: "sent",
      amountCents: 0,
    });
    expect(env.payments.callsTo("transfer")).toHaveLength(0);
  });

  it("refuses payments that cannot be transferred", async () => {
    vi.mocked(data.findPayment).mockResolvedValue(undefined);
    await expect(createHostTransfer(env.services, PAYMENT_ID)).rejects.toThrow(/no payment/);
    vi.mocked(data.findPayment).mockResolvedValue(payment());
    await expect(createHostTransfer(env.services, PAYMENT_ID)).rejects.toThrow(/not captured/);
    vi.mocked(data.findPayment).mockResolvedValue(captured());
    vi.mocked(data.findTransferContext).mockResolvedValue(undefined);
    await expect(createHostTransfer(env.services, PAYMENT_ID)).rejects.toThrow(/no booking/);
    vi.mocked(data.findPayment).mockResolvedValue(captured({ stripeChargeId: null }));
    vi.mocked(data.findTransferContext).mockResolvedValue(context());
    await expect(createHostTransfer(env.services, PAYMENT_ID)).rejects.toThrow(/no charge/);
  });
});
