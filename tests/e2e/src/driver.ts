import { type Person, signUp } from "./accounts.ts";
import type { LatLng } from "./host.ts";
import type { Reply } from "./http.ts";
import type { Slot } from "./slots.ts";
import { saveCard } from "./stripe.ts";
import { eventually } from "./wait.ts";

export interface Booking {
  readonly id: string;
  readonly chargerId: string;
  readonly status: string;
  readonly start: string;
  readonly end: string;
  readonly quotedAmountCents: number;
  readonly pricePerHourCents: number;
  readonly cancelledBy: string | null;
  readonly addressVisible: boolean;
  readonly payment: { readonly status: string; readonly amountCents: number } | null;
}

export interface SessionState {
  readonly bookingId: string;
  readonly sessionId: string | null;
  readonly status: string;
  readonly kwh: number | null;
  readonly elapsed: number;
  readonly stoppedAt: string | null;
  readonly stopReason: string | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
}

/** A new driver with a saved card. */
export async function newDriver(firstName: string): Promise<Person> {
  const driver = await signUp(firstName);
  await saveCard(driver.api);
  return driver;
}

/** Search near `near` for the slot; the ids of the chargers found. */
export async function search(driver: Person, near: LatLng, slot: Slot): Promise<string[]> {
  const query = new URLSearchParams({
    lat: String(near.lat),
    lng: String(near.lng),
    radius: "1000",
    from: slot.start.toISOString(),
    to: slot.end.toISOString(),
  });
  const { results } = await driver.api.get<{ results: { id: string }[] }>(
    `/chargers?${query.toString()}`,
  );
  return results.map((result) => result.id);
}

/** Asks to book the slot; the reply as it came, for tests that expect a refusal. */
export function requestBooking(
  driver: Person,
  chargerId: string,
  slot: Slot,
): Promise<Reply<Booking>> {
  return driver.api.send<Booking>("POST", "/bookings", {
    chargerId,
    from: slot.start.toISOString(),
    to: slot.end.toISOString(),
    vehiclePlate: "251-D-12345",
  });
}

/** Books the slot; fails the test unless the booking is made. */
export async function book(driver: Person, chargerId: string, slot: Slot): Promise<Booking> {
  const reply = await requestBooking(driver, chargerId, slot);
  if (reply.status !== 201) {
    throw new Error(`booking refused (${String(reply.status)}): ${JSON.stringify(reply.body)}`);
  }
  return reply.body;
}

/** The booking's live session, as the driver or host sees it. */
export function sessionOf(person: Person, bookingId: string): Promise<SessionState> {
  return person.api.get<SessionState>(`/bookings/${bookingId}/session`);
}

/** Polls the booking's session until `done` holds; returns that state. */
export function awaitSession(
  person: Person,
  bookingId: string,
  what: string,
  done: (state: SessionState) => boolean,
  timeoutMs = 30_000,
): Promise<SessionState> {
  return eventually(
    `the session to be ${what}`,
    async () => {
      const state = await sessionOf(person, bookingId);
      return done(state) ? state : undefined;
    },
    { timeoutMs, intervalMs: 500 },
  );
}

/** Polls the booking until `done` holds; returns it. */
export function awaitBooking(
  person: Person,
  bookingId: string,
  what: string,
  done: (booking: Booking) => boolean,
  timeoutMs = 30_000,
): Promise<Booking> {
  return eventually(
    `the booking to be ${what}`,
    async () => {
      const booking = await person.api.get<Booking>(`/bookings/${bookingId}`);
      return done(booking) ? booking : undefined;
    },
    { timeoutMs, intervalMs: 500 },
  );
}
