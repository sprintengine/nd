import { startZappiSim, ZappiConnectError } from "@nd/ocpp-core/sim";
import { afterAll, describe, expect, it } from "vitest";

import type { Person } from "./accounts.ts";
import { awaitSession, book, type Booking, newDriver, requestBooking } from "./driver.ts";
import { connectZappi, dublinSpot, listCharger, type ListedCharger } from "./host.ts";
import { problemCode } from "./http.ts";
import { type Slot, upcomingSlot } from "./slots.ts";
import { sleep, sleepUntil } from "./wait.ts";

// Scenario 4: nothing unlocks the charger but the booking it is for, a
// charger with the wrong password is turned away, and a slot is sold once.

describe("safety", () => {
  let listed: ListedCharger;
  let driver: Person;
  let other: Person;
  let slot: Slot;
  let booking: Booking;

  afterAll(async () => {
    await listed.sim.stop();
  });

  it("turns away a charger with the wrong password, or none", async () => {
    listed = await listCharger("Orla", dublinSpot(2), { instantBook: true });
    const refused = (attempt: Promise<unknown>) =>
      attempt.then(
        () => undefined,
        (error: unknown) => error,
      );
    const wrong = await refused(
      connectZappi({ ...listed.credentials, secret: "not-the-password-0000" }),
    );
    expect(wrong).toBeInstanceOf(ZappiConnectError);
    expect((wrong as ZappiConnectError).statusCode).toBe(401);
    const none = await refused(
      startZappiSim({
        url: listed.credentials.wssUrl,
        chargeboxId: listed.credentials.chargeboxId,
      }),
    );
    expect(none).toBeInstanceOf(ZappiConnectError);
    expect((none as ZappiConnectError).statusCode).toBe(401);
    // The real charger is still the one connected.
    expect(listed.sim.state.connected).toBe(true);
  });

  it("blocks a second booking of the same slot", async () => {
    [driver, other] = await Promise.all([newDriver("Eoin"), newDriver("Ciara")]);
    slot = upcomingSlot(5);
    booking = await book(driver, listed.credentials.chargerId, slot);
    expect(booking.status).toBe("confirmed");

    const same = await requestBooking(other, listed.credentials.chargerId, slot);
    expect(same.status).toBe(409);
    const overlapping = await requestBooking(other, listed.credentials.chargerId, {
      start: new Date(slot.start.getTime() + 2 * 60_000),
      end: new Date(slot.end.getTime() + 2 * 60_000),
    });
    expect(overlapping.status).toBe(409);
    expect(problemCode(overlapping.body)).toBeDefined();
  });

  it("refuses a wrong unlock code or ID tag at the charger", async () => {
    await driver.api.post(`/bookings/${booking.id}/arrive`);
    listed.sim.plugIn();
    for (const tag of ["WRONGCODE0000000", "ABCDEFGHJKLMNPQRSTUV", "12345678"]) {
      const answer = await listed.sim.enterPin(tag);
      expect(answer.idTagInfo.status, tag).not.toBe("Accepted");
    }
    await sleep(1000);
    expect(listed.sim.state.transaction).toBeUndefined();
    expect(listed.sim.state.status).not.toBe("Charging");
  });

  it("lets only the booking's driver start it", async () => {
    await sleepUntil(slot.start);
    const stranger = await other.api.send("POST", `/bookings/${booking.id}/start`);
    expect(stranger.status).toBe(404);
    const host = await listed.host.api.send("POST", `/bookings/${booking.id}/start`);
    expect(host.status).toBe(403);
    expect((await other.api.send("GET", `/bookings/${booking.id}/session`)).status).toBe(404);

    await driver.api.post(`/bookings/${booking.id}/start`);
    await awaitSession(driver, booking.id, "charging", (s) => s.status === "charging");
    await driver.api.post(`/bookings/${booking.id}/stop`);
    await awaitSession(driver, booking.id, "stopped", (s) => s.stoppedAt !== null);
  });
});
