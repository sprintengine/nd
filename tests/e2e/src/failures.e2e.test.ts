import { afterAll, describe, expect, it } from "vitest";

import { STALE_SESSION_GRACE_MINUTES, START_TIMEOUT_SECONDS } from "./config.ts";
import { awaitBooking, awaitSession, book, newDriver, type SessionState } from "./driver.ts";
import { dublinSpot, listCharger, type ListedCharger } from "./host.ts";
import { upcomingSlot } from "./slots.ts";
import { eventually, sleep, sleepUntil } from "./wait.ts";

// Scenario 5: chargers that fail. The stack shortens the start timeout to
// 8 seconds and the stale-session grace to one minute.

const chargers: ListedCharger[] = [];

afterAll(async () => {
  await Promise.all(chargers.map((listed) => listed.sim.stop()));
});

describe.concurrent("a failing charger", () => {
  it("fails a start the charger never confirms, after the start timeout", async () => {
    const listed = await listCharger("Ronan", dublinSpot(3), {
      instantBook: true,
      sim: { faults: { neverSendStartTransaction: true } },
    });
    chargers.push(listed);
    const driver = await newDriver("Aisling");
    const slot = upcomingSlot(5);
    const booking = await book(driver, listed.credentials.chargerId, slot);
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
    // Nothing was billed for a session that never started.
    const unbilled = await driver.api.get<{ payment: { capturedCents: number } | null }>(
      `/bookings/${booking.id}`,
    );
    expect(unbilled.payment?.capturedCents ?? 0).toBe(0);
  });

  it("closes a session whose charger dropped before StopTransaction, after the grace", async () => {
    // One minute at €60/h: a €1.00 quote, which caps the bill.
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
      "closed for the host to confirm",
      (s) => s.status === "needs_host_confirmation",
      // Slot end, plus the one-minute grace, plus up to a minute for the sweep.
      4 * 60_000,
    );
    expect(Date.now()).toBeGreaterThan(slot.end.getTime() + STALE_SESSION_GRACE_MINUTES * 60_000);
    expect(closed.sessionId).toBe(charging.sessionId);

    await listed.host.api.expect(
      202,
      "POST",
      `/hosts/sessions/${String(closed.sessionId)}/confirm`,
    );
    const settled = await awaitBooking(
      driver,
      booking.id,
      "captured",
      (b) => b.payment?.status === "captured",
      60_000,
    );
    expect(settled.payment?.capturedCents).toBe(booking.quotedAmountCents);
    const receipt = await eventually("the receipt", async () => {
      const reply = await driver.api.send<{ totalCents: number }>(
        "GET",
        `/bookings/${booking.id}/receipt`,
      );
      return reply.status === 200 ? reply.body : undefined;
    });
    expect(receipt.totalCents).toBe(booking.quotedAmountCents);
  });
});
