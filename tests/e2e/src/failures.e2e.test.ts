import { afterAll, describe, expect, it } from "vitest";

import { STALE_SESSION_GRACE_MINUTES, START_TIMEOUT_SECONDS } from "./config.ts";
import { awaitBooking, awaitSession, book, newDriver, type SessionState } from "./driver.ts";
import { dublinSpot, listCharger, type ListedCharger } from "./host.ts";
import { upcomingSlot } from "./slots.ts";
import { refundsFor } from "./stripe.ts";
import { eventually, sleep, sleepUntil } from "./wait.ts";

// Scenario 5: chargers that fail. The stack shortens the start timeout to
// 8 seconds and the stale-session grace to one minute.

interface Receipt {
  readonly paidCents: number;
  readonly refundedCents: number;
  readonly totalCents: number;
  readonly refunds: readonly { readonly reason: string; readonly amountCents: number }[];
  readonly session: { readonly kwh: number | null; readonly stopReason: string | null } | null;
}

const chargers: ListedCharger[] = [];

afterAll(async () => {
  await Promise.all(chargers.map((listed) => listed.sim.stop()));
});

describe.concurrent("a failing charger", () => {
  it("fails a start the charger never confirms, and refunds the driver in full", async () => {
    // One minute at €60/h: €1.00, paid upfront (a card payment is at least 50 cents).
    const listed = await listCharger("Ronan", dublinSpot(3), {
      instantBook: true,
      pricePerHourCents: 6000,
      sim: { faults: { neverSendStartTransaction: true } },
    });
    chargers.push(listed);
    const driver = await newDriver("Aisling");
    const slot = upcomingSlot(1);
    const booking = await book(driver, listed.credentials.chargerId, slot);
    expect(booking.payment?.status).toBe("paid");
    await driver.api.post(`/bookings/${booking.id}/arrive`);
    listed.sim.plugIn();
    await sleepUntil(slot.start);

    const startedAt = Date.now();
    await driver.api.post(`/bookings/${booking.id}/start`);
    expect((await awaitSession(driver, booking.id, "starting", () => true)).status).toBe(
      "starting",
    );
    const failed = await awaitSession(
      driver,
      booking.id,
      "failed",
      (s) => s.status === "failed",
      60_000,
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(START_TIMEOUT_SECONDS * 1000);
    expect(failed.failure?.code).toBe("start_timeout");
    expect(failed.failure?.message).toBeTruthy();

    // The driver gives up; after the slot the charger's fault is refunded automatically.
    const closed = await awaitBooking(
      driver,
      booking.id,
      "completed",
      (b) => b.status === "completed",
      // Slot end, plus the one-minute grace, plus up to a minute for the sweep.
      4 * 60_000,
    );
    expect(closed.payment?.status).toBe("paid");
    const refunds = await eventually("the refund", async () => {
      const made = await refundsFor(booking.id);
      return made.length > 0 ? made : undefined;
    });
    expect(refunds).toEqual([
      expect.objectContaining({
        amount: booking.quotedAmountCents,
        reverseTransfer: true,
        refundApplicationFee: true,
      }),
    ]);
    const receipt = await driver.api.get<Receipt>(`/bookings/${booking.id}/receipt`);
    expect(receipt).toMatchObject({
      paidCents: booking.quotedAmountCents,
      refundedCents: booking.quotedAmountCents,
      totalCents: 0,
      refunds: [{ reason: "charger_fault" }],
    });
  });

  it("closes a session whose charger dropped before StopTransaction, after the grace", async () => {
    // One minute at €60/h: €1.00, paid upfront.
    const listed = await listCharger("Siobhan", dublinSpot(4), {
      instantBook: true,
      pricePerHourCents: 6000,
    });
    chargers.push(listed);
    const driver = await newDriver("Darragh");
    const slot = upcomingSlot(1);
    const booking = await book(driver, listed.credentials.chargerId, slot);
    await driver.api.post(`/bookings/${booking.id}/arrive`);
    listed.sim.plugIn();
    await sleepUntil(slot.start);
    await driver.api.post(`/bookings/${booking.id}/start`);
    const charging = await awaitSession(
      driver,
      booking.id,
      "charging",
      (s) => s.status === "charging",
    );
    await sleep(1000);
    await listed.sim.sendMeterValues("Sample.Periodic");
    await awaitSession(driver, booking.id, "metered", (s) => (s.kwh ?? 0) > 0);

    // The charger loses its connection mid-session and never comes back.
    listed.sim.disconnect();

    const closed: SessionState = await awaitSession(
      listed.host,
      booking.id,
      "closed from its last meter value",
      (s) => s.status === "reconciled",
      // Slot end, plus the one-minute grace, plus up to a minute for the sweep.
      4 * 60_000,
    );
    expect(Date.now()).toBeGreaterThan(slot.end.getTime() + STALE_SESSION_GRACE_MINUTES * 60_000);
    expect(closed.sessionId).toBe(charging.sessionId);
    expect(closed.stopReason).toBe("NoStopTransaction");

    const completed = await awaitBooking(
      driver,
      booking.id,
      "completed",
      (b) => b.status === "completed",
    );
    expect(completed.payment).toEqual({ status: "paid", amountCents: booking.quotedAmountCents });
    const receipt = await driver.api.get<Receipt>(`/bookings/${booking.id}/receipt`);
    expect(receipt).toMatchObject({
      totalCents: booking.quotedAmountCents,
      refundedCents: 0,
      session: { stopReason: "NoStopTransaction" },
    });
    expect(receipt.session?.kwh).toBeGreaterThan(0);
  });
});
