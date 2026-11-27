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
import { accountOf, paymentIntentsFor, refundsFor } from "./stripe.ts";
import { eventually, sleep } from "./wait.ts";

// Scenarios 1 and 2, one story: a host lists a Zappi; a driver finds it and
// asks to book, the price is held on the card, and the host approves (the
// card is charged, the host's account receives it less the card fee). The
// driver plugs in before the slot, charging starts at the slot start, and
// stopping early changes nothing about what was paid.

interface Receipt {
  readonly paidCents: number;
  readonly refundedCents: number;
  readonly totalCents: number;
  readonly session: {
    readonly kwh: number | null;
    readonly samples: readonly { readonly at: string }[];
  } | null;
  readonly hostEarnings: {
    readonly grossCents: number;
    readonly cardFeeCents: number;
    readonly netCents: number;
  } | null;
}

// 10 minutes at €12/h: €2.00, paid upfront. The card fee passed on to the host
// is 1.5 % rounded up (3 cents) plus 25 cents.
const PRICE_PER_HOUR_CENTS = 1200;
const SLOT_MINUTES = 10;
const PRICE_CENTS = 200;
const CARD_FEE_CENTS = 28;

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
    // The host's charger view (PATCH answers with it).
    const charger = await listed.host.api.expect<{ netPerHourCents: number | null }>(
      200,
      "PATCH",
      `/hosts/chargers/${listed.credentials.chargerId}`,
      {},
    );
    // "You receive €11.57 an hour after card fees": 1200 less 18 and 25 cents.
    expect(charger.netPerHourCents).toBe(1157);
  });

  it("lets a driver find the charger and see its listing", async () => {
    driver = await newDriver("Cian");
    // A minute or two away, so the driver can plug in before it starts.
    slot = upcomingSlot(SLOT_MINUTES, 90);
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

  it("holds the price of a request on the card, and charges it when the host approves", async () => {
    booking = await book(driver, listed.credentials.chargerId, slot);
    expect(booking.status).toBe("requested");
    expect(booking.quotedAmountCents).toBe(PRICE_CENTS);
    expect(booking.payment).toEqual({ status: "authorised", amountCents: PRICE_CENTS });
    const destination = await accountOf(listed.host.hostId);
    const held = await paymentIntentsFor(booking.id);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      status: "requires_capture",
      capture_method: "manual",
      amount_capturable: PRICE_CENTS,
      transfer_data: { destination },
      application_fee_amount: CARD_FEE_CENTS,
    });

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
    expect(confirmed.payment).toEqual({ status: "paid", amountCents: PRICE_CENTS });
    const charged = await paymentIntentsFor(booking.id);
    expect(charged).toHaveLength(1);
    expect(charged[0]).toMatchObject({ status: "succeeded", amount_received: PRICE_CENTS });
  });

  it("lets the driver plug in early, and starts charging at the slot start", async () => {
    expect(Date.now()).toBeLessThan(slot.start.getTime());
    await driver.api.post(`/bookings/${booking.id}/arrive`, listed.location);
    listed.sim.plugIn();
    const waiting = await driver.api.post<SessionState>(`/bookings/${booking.id}/start`);
    expect(waiting.status).toBe("scheduled");
    expect(waiting.elapsed).toBe(0);
    session = await awaitSession(
      driver,
      booking.id,
      "charging",
      (s) => s.status === "charging",
      slot.start.getTime() - Date.now() + 60_000,
    );
    expect(Date.now()).toBeGreaterThanOrEqual(slot.start.getTime());
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
    expect(session.elapsed).toBeGreaterThan(0);
    // The host sees the same live session.
    const hostSees = await listed.host.api.get<SessionState>(`/bookings/${booking.id}/session`);
    expect(hostSees.sessionId).toBe(session.sessionId);
  });

  it("stops early: the driver paid for the booked hours, and the receipts show the session", async () => {
    await driver.api.post(`/bookings/${booking.id}/stop`);
    await eventually("the charger to end its transaction", () =>
      Promise.resolve(listed.sim.state.transaction === undefined ? true : undefined),
    );
    const completed = await awaitBooking(
      driver,
      booking.id,
      "completed",
      (b) => b.status === "completed",
      60_000,
    );
    expect(completed.payment).toEqual({ status: "paid", amountCents: PRICE_CENTS });

    const receipt = await eventually(
      "the driver's receipt",
      async () => {
        const reply = await driver.api.send<Receipt>("GET", `/bookings/${booking.id}/receipt`);
        return reply.status === 200 && (reply.body.session?.kwh ?? 0) > 0 ? reply.body : undefined;
      },
      { timeoutMs: 30_000 },
    );
    expect(receipt).toMatchObject({ paidCents: PRICE_CENTS, refundedCents: 0, totalCents: 200 });
    expect(receipt.session?.samples.length).toBeGreaterThan(0);
    expect(receipt.hostEarnings).toBeNull();

    const hostReceipt = await listed.host.api.get<Receipt>(`/bookings/${booking.id}/receipt`);
    expect(hostReceipt.hostEarnings).toEqual({
      grossCents: PRICE_CENTS,
      cardFeeCents: CARD_FEE_CENTS,
      platformFeeCents: 0,
      netCents: PRICE_CENTS - CARD_FEE_CENTS,
    });

    // One charge, never adjusted afterwards.
    const intents = await paymentIntentsFor(booking.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ status: "succeeded", amount_received: PRICE_CENTS });
    expect(await refundsFor(booking.id)).toEqual([]);
  });
});
