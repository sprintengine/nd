import { afterAll, describe, expect, it } from "vitest";

import type { Person } from "./accounts.ts";
import {
  awaitBooking,
  awaitSession,
  book,
  type Booking,
  newDriver,
  search,
  type SessionState,
} from "./driver.ts";
import { dublinSpot, listCharger, type ListedCharger } from "./host.ts";
import { Feed } from "./realtime.ts";
import { type Slot, upcomingSlot } from "./slots.ts";
import { accountOf, paymentIntentsFor, transfersFor } from "./stripe.ts";
import { eventually, sleep, sleepUntil } from "./wait.ts";

// Scenarios 1 and 2, one story: a host lists a Zappi; a driver finds it,
// books, is approved, arrives, charges and stops; the booking is billed for
// the time used and the host is paid.

interface Receipt {
  readonly totalCents: number;
  readonly billedMinutes: number;
  readonly kwh: number | null;
  readonly hostPayout: { readonly amountCents: number; readonly status: string } | null;
}

// 10 minutes at €12/h: a quote of €2.00. Charging lasts well under five
// minutes, so the bill is five minutes' worth, €1.00.
const PRICE_PER_HOUR_CENTS = 1200;
const SLOT_MINUTES = 10;
const QUOTE_CENTS = 200;
const BILLED_CENTS = 100;

describe("a host lists a Zappi and a driver charges at it", () => {
  let listed: ListedCharger;
  let driver: Person;
  let feed: Feed | undefined;
  let slot: Slot;
  let booking: Booking;
  let session: SessionState;

  afterAll(async () => {
    feed?.close();
    await listed.sim.stop();
  });

  it("onboards the host and the charger, sets price and hours, and publishes", async () => {
    listed = await listCharger("Aoife", dublinSpot(0), {
      pricePerHourCents: PRICE_PER_HOUR_CENTS,
      instantBook: false,
    });
    const me = await listed.host.api.get<{ isHost: boolean; host: { payoutsEnabled: boolean } }>(
      "/me",
    );
    expect(me.isHost).toBe(true);
    expect(me.host.payoutsEnabled).toBe(true);
    expect(listed.sim.state.registration).toBe("Accepted");
  });

  it("lets a driver find the charger and see its listing", async () => {
    driver = await newDriver("Cian");
    slot = upcomingSlot(SLOT_MINUTES);
    expect(await search(driver, listed.location, slot)).toContain(listed.credentials.chargerId);
    const listing = await driver.api.get<{
      pricePerHourCents: number;
      addressVisible: boolean;
      address: string | null;
    }>(`/chargers/${listed.credentials.chargerId}`);
    expect(listing.pricePerHourCents).toBe(PRICE_PER_HOUR_CENTS);
    expect(listing.addressVisible).toBe(false);
    expect(listing.address).toBeNull();
  });

  it("books a request, which the host approves", async () => {
    booking = await book(driver, listed.credentials.chargerId, slot);
    expect(booking.status).toBe("requested");
    expect(booking.quotedAmountCents).toBe(QUOTE_CENTS);

    const { bookings } = await listed.host.api.get<{ bookings: Booking[] }>("/hosts/bookings");
    expect(bookings.map((b) => b.id)).toContain(booking.id);

    feed = await Feed.open(driver.api);
    const approved = await listed.host.api.post<Booking>(`/bookings/${booking.id}/approve`);
    expect(approved.status).toBe("confirmed");
    await feed.next(
      "booking:update",
      (m) => m.bookingId === booking.id && m.status === "confirmed",
    );

    const confirmed = await driver.api.get<Booking>(`/bookings/${booking.id}`);
    expect(confirmed.addressVisible).toBe(true);
    expect(confirmed.payment).toMatchObject({ status: "authorised", authorisedCents: QUOTE_CENTS });
    const intents = await paymentIntentsFor(booking.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      status: "requires_capture",
      capture_method: "manual",
      amount_capturable: QUOTE_CENTS,
    });
  });

  it("starts charging once the driver arrives and the slot begins", async () => {
    await driver.api.post(`/bookings/${booking.id}/arrive`, listed.location);
    listed.sim.plugIn();
    await sleepUntil(slot.start);
    await driver.api.post(`/bookings/${booking.id}/start`);
    session = await awaitSession(driver, booking.id, "charging", (s) => s.status === "charging");
    expect(listed.sim.state.transaction?.id).toBeTypeOf("number");
    await feed?.next(
      "session:update",
      (m) => m.bookingId === booking.id && m.status === "charging",
    );
    expect((await driver.api.get<Booking>(`/bookings/${booking.id}`)).status).toBe("active");
  });

  it("shows the meter values the charger sends", async () => {
    await sleep(1500);
    await listed.sim.sendMeterValues("Sample.Periodic");
    await sleep(1500);
    await listed.sim.sendMeterValues("Sample.Periodic");
    session = await awaitSession(driver, booking.id, "metered", (s) => (s.kwh ?? 0) > 0);
    expect(session.costSoFar).toBeGreaterThan(0);
    // The host sees the same live session.
    const hostSees = await listed.host.api.get<SessionState>(`/bookings/${booking.id}/session`);
    expect(hostSees.sessionId).toBe(session.sessionId);
  });

  it("stops, bills the time used and pays the host", async () => {
    await driver.api.post(`/bookings/${booking.id}/stop`);
    await eventually("the charger to end its transaction", () =>
      Promise.resolve(listed.sim.state.transaction === undefined ? true : undefined),
    );
    const settled = await awaitBooking(
      driver,
      booking.id,
      "completed and captured",
      (b) => b.status === "completed" && b.payment?.status === "captured",
      60_000,
    );
    expect(settled.payment?.capturedCents).toBe(BILLED_CENTS);

    const receipt = await eventually(
      "the driver's receipt",
      async () => {
        const reply = await driver.api.send<Receipt>("GET", `/bookings/${booking.id}/receipt`);
        return reply.status === 200 ? reply.body : undefined;
      },
      { timeoutMs: 30_000 },
    );
    expect(receipt.totalCents).toBe(BILLED_CENTS);
    expect(receipt.billedMinutes).toBe(5);
    expect(receipt.kwh).toBeGreaterThan(0);

    const intents = await paymentIntentsFor(booking.id);
    expect(intents[0]).toMatchObject({ status: "succeeded", amount_received: BILLED_CENTS });

    const transfers = await eventually(
      "the host's transfer",
      async () => {
        const made = await transfersFor(booking.id);
        return made.length > 0 ? made : undefined;
      },
      { timeoutMs: 60_000 },
    );
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      amount: BILLED_CENTS,
      destination: await accountOf(listed.host.hostId),
    });

    const hostReceipt = await eventually("the host's payout on the receipt", async () => {
      const seen = await listed.host.api.get<Receipt>(`/bookings/${booking.id}/receipt`);
      return seen.hostPayout?.status === "sent" ? seen : undefined;
    });
    expect(hostReceipt.hostPayout?.amountCents).toBe(BILLED_CENTS);
  });
});
