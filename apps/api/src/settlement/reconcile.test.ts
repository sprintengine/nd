import { beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_ID, bookingDetail, payment, PAYMENT_ID } from "../../test/booking-detail.ts";
import {
  SESSION_ID,
  settlementServices,
  settlementSession,
} from "../../test/settlement-session.ts";
import * as bookingData from "../data/bookings.ts";
import * as data from "../data/settlement.ts";
import { captureSession, reconcileSession } from "./reconcile.ts";

vi.mock("../data/bookings.ts");
vi.mock("../data/settlement.ts");

let env: ReturnType<typeof settlementServices>;
const warn = vi.fn();
const error = vi.fn();

function found(...args: Parameters<typeof settlementSession>) {
  const value = settlementSession(...args);
  vi.mocked(data.findSettlementSession).mockResolvedValue(value);
  return value;
}

beforeEach(() => {
  vi.resetAllMocks();
  env = settlementServices(new Date("2027-01-13T09:00:00Z"), {
    log: { info: vi.fn(), warn, error },
  });
  vi.mocked(bookingData.findBookingDetail).mockResolvedValue(bookingDetail("user-cian"));
  vi.mocked(bookingData.updatePaymentFrom).mockResolvedValue(true);
  vi.mocked(bookingData.findPayment).mockResolvedValue(undefined);
  vi.mocked(data.updateSessionFrom).mockResolvedValue(true);
});

const sessionChanges = () => vi.mocked(data.updateSessionFrom).mock.calls.map((call) => call[3]);

describe("reconcileSession", () => {
  it("captures 3 h 40 min at 250 cents an hour, marks it reconciled and pays the host", async () => {
    const captured = { status: "captured", capturedCents: 917, stripeChargeId: "ch_pi_1" } as const;
    vi.mocked(data.findSettlementSession)
      .mockResolvedValueOnce(settlementSession())
      .mockResolvedValueOnce(settlementSession({ payment: captured }));
    vi.mocked(bookingData.findTransfer).mockResolvedValue(undefined);
    vi.mocked(bookingData.findPayment).mockResolvedValue(payment(captured));
    vi.mocked(bookingData.findTransferContext).mockResolvedValue({
      bookingId: BOOKING_ID,
      stripeAccountId: "acct_1",
      payoutStatus: "enabled",
      taxDetailsComplete: true,
      sessionStatus: "reconciled",
      disputeOpen: false,
    });
    vi.mocked(bookingData.saveTransfer).mockResolvedValue({ status: "sent" } as never);

    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("reconciled");
    expect(env.payments.callsTo("capture")).toEqual([
      {
        method: "capture",
        input: {
          paymentIntentId: "pi_1",
          amountCents: 917,
          idempotencyKey: `booking-${BOOKING_ID}-capture`,
        },
      },
    ]);
    expect(sessionChanges()).toEqual([
      { status: "reconciled", reconciledAt: env.clock.now(), kwh: 22.5 },
    ]);
    expect(env.pushed).toEqual([{ kind: "session", bookingId: BOOKING_ID }]);
    expect(env.payments.callsTo("transfer")).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({ amountCents: 917, destination: "acct_1" }) as unknown,
      }),
    ]);
  });

  it("bills a scheduled start from plug-in, not from StartTransaction", async () => {
    vi.mocked(bookingData.findTransfer).mockResolvedValue({ id: "t1" } as never);
    const pluggedInAt = new Date("2027-01-12T22:00:00Z");
    found({
      booking: { pluggedInAt },
      session: { startedAt: new Date("2027-01-12T23:00:00Z") },
    });
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("reconciled");
    expect(env.payments.callsTo("capture")).toEqual([
      expect.objectContaining({ input: expect.objectContaining({ amountCents: 917 }) as unknown }),
    ]);
  });

  it("does not transfer again for a session with a transfer", async () => {
    found({
      session: { status: "reconciled" },
      payment: { status: "captured", capturedCents: 917 },
    });
    vi.mocked(bookingData.findTransfer).mockResolvedValue({ id: "t1" } as never);
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("already_reconciled");
    expect(env.payments.calls).toEqual([]);
    expect(data.updateSessionFrom).not.toHaveBeenCalled();
  });

  it("leaves a reconciled session without a capture alone", async () => {
    found({ session: { status: "reconciled" }, payment: { status: "cancelled" } });
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("already_reconciled");
    expect(bookingData.findTransfer).not.toHaveBeenCalled();
  });

  it("is not_found for an unknown session and waits for one still open", async () => {
    vi.mocked(data.findSettlementSession).mockResolvedValue(undefined);
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("not_found");
    found({ session: { status: "charging" } });
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("waiting");
  });

  it("flags a meter disagreement of 0.5 kWh and captures nothing", async () => {
    found({ lastMeterValue: { ts: new Date(), energyWh: 23_000 } });
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("needs_review");
    expect(sessionChanges()).toEqual([{ status: "needs_review", reviewReason: "meter_mismatch" }]);
    expect(env.payments.calls).toEqual([]);
    expect(env.pushed).toEqual([{ kind: "session", bookingId: BOOKING_ID }]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "meter_mismatch" }),
      expect.stringContaining("needs review"),
    );
  });

  it("flags a session without a stop time or with a stop before its start", async () => {
    found({ session: { stoppedAt: null } });
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("needs_review");
    found({ session: { stoppedAt: new Date("2027-01-01T00:00:00Z") } });
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("needs_review");
    expect(sessionChanges()).toEqual([
      { status: "needs_review", reviewReason: "meter_invalid" },
      { status: "needs_review", reviewReason: "meter_invalid" },
    ]);
  });

  it("gives a session the gateway flagged a reason, once", async () => {
    found({ session: { status: "needs_review" } });
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("needs_review");
    found({ session: { status: "needs_review", reviewReason: "meter_mismatch" } });
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("needs_review");
    expect(sessionChanges()).toEqual([{ status: "needs_review", reviewReason: "meter_invalid" }]);
  });

  it("flags a session with no authorisation to capture", async () => {
    found({ payment: { status: "card_saved" } });
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("needs_review");
    found({ payment: null });
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("needs_review");
    expect(sessionChanges()).toEqual([
      { status: "needs_review", reviewReason: "no_authorisation" },
      { status: "needs_review", reviewReason: "no_authorisation" },
    ]);
  });

  it("flags a capture the payment refuses", async () => {
    found();
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(
      bookingDetail("user-cian", { payment: { authorisedCents: 500 } }),
    );
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("needs_review");
    expect(error).toHaveBeenCalledWith(expect.anything(), "session cannot be captured");
    expect(sessionChanges()).toEqual([
      { status: "needs_review", reviewReason: "no_authorisation" },
    ]);
  });

  it("retries a failing capture, then flags it on the last attempt", async () => {
    found();
    vi.spyOn(env.payments.payments, "capture").mockRejectedValue(new Error("network down"));
    await expect(
      reconcileSession(env.services, SESSION_ID, { lastAttempt: false }),
    ).rejects.toThrow("network down");
    expect(data.updateSessionFrom).not.toHaveBeenCalled();
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("needs_review");
    expect(sessionChanges()).toEqual([{ status: "needs_review", reviewReason: "capture_failed" }]);
  });

  describe("a session closed without a stop", () => {
    const due = new Date("2027-01-15T02:10:00Z");

    it("waits for the host or the deadline", async () => {
      found({ session: { status: "needs_host_confirmation", confirmationDueAt: due } });
      await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("waiting");
      found({ session: { status: "needs_host_confirmation", confirmationDueAt: null } });
      await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("waiting");
      expect(env.payments.calls).toEqual([]);
    });

    it("is billed once the host confirms or the deadline passes", async () => {
      vi.mocked(bookingData.findTransfer).mockResolvedValue({ id: "t1" } as never);
      found({
        session: {
          status: "needs_host_confirmation",
          confirmationDueAt: due,
          hostConfirmedAt: new Date(),
        },
      });
      await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("reconciled");
      env.clock.current = due;
      found({ session: { status: "needs_host_confirmation", confirmationDueAt: due } });
      await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("reconciled");
      expect(env.payments.callsTo("capture")).toHaveLength(2);
    });
  });
});

describe("captureSession", () => {
  it("does nothing for 0 cents without an authorisation, and releases one that exists", async () => {
    await expect(
      captureSession(env.services, settlementSession({ payment: null }), 0),
    ).resolves.toBeUndefined();
    await expect(captureSession(env.services, settlementSession(), 0)).resolves.toMatchObject({
      paymentId: PAYMENT_ID,
      capturedCents: 0,
    });
    expect(env.payments.callsTo("cancelAuthorisation")).toHaveLength(1);
  });
});
