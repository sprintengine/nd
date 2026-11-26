import type { BookingDetail, Payment } from "../src/data/bookings.ts";

export const BOOKING_ID = "11111111-1111-4111-8111-111111111111";
export const CHARGER_ID = "22222222-2222-4222-8222-222222222222";
export const PAYMENT_ID = "33333333-3333-4333-8333-333333333333";
export const HOST_USER_ID = "user-niamh";

/** A payment row for unit tests. */
export function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: PAYMENT_ID,
    bookingId: BOOKING_ID,
    stripePaymentIntentId: "pi_1",
    stripeSetupIntentId: null,
    stripePaymentMethodId: "pm_card_visa",
    stripeChargeId: null,
    failureReason: null,
    authoriseAt: null,
    authorisedCents: 1000,
    capturedCents: 0,
    platformFeeCents: 0,
    currency: "EUR",
    status: "authorised",
    createdAt: new Date("2027-01-01T00:00:00Z"),
    updatedAt: new Date("2027-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** A confirmed 4-hour booking from 22:00 UTC on 2027-01-12 at 250 cents an hour, by `driverId`. */
export function bookingDetail(
  driverId: string,
  overrides: {
    booking?: Partial<BookingDetail["booking"]>;
    payment?: Partial<Payment> | null;
    host?: Partial<BookingDetail["host"]>;
    driver?: Partial<BookingDetail["driver"]>;
  } = {},
): BookingDetail {
  return {
    booking: {
      id: BOOKING_ID,
      chargerId: CHARGER_ID,
      driverId,
      slot: { start: new Date("2027-01-12T22:00:00Z"), end: new Date("2027-01-13T02:00:00Z") },
      status: "confirmed",
      idTag: "ABCDEFGHJKLMNPQRSTUV",
      quotedAmountCents: 1000,
      pricePerHourCents: 250,
      currency: "EUR",
      kwhCap: null,
      vehiclePlate: "251-D-1234",
      scheduledStartAt: null,
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
      cancellationFeeCents: 0,
      createdAt: new Date("2027-01-10T12:00:00Z"),
      updatedAt: new Date("2027-01-10T12:00:00Z"),
      ...overrides.booking,
    },
    charger: {
      id: CHARGER_ID,
      address: "7 Test Row, Dublin 6",
      location: { lat: 53.33, lng: -6.25 },
      timezone: "Europe/Dublin",
    },
    host: { id: "host-1", userId: HOST_USER_ID, cancellationCutoffMinutes: 120, ...overrides.host },
    driver: { name: "Cian Byrne", stripeCustomerId: "cus_1", ...overrides.driver },
    payment: overrides.payment === null ? null : payment(overrides.payment),
  };
}
