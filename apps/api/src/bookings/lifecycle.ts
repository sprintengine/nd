import {
  cancellationRefund,
  chargeSplit,
  isCancellable,
  noShowAt,
  quote,
  requestExpiresAt,
} from "@nd/domain";

import {
  type BookingChange,
  type BookingDetail,
  findBookableCharger,
  findBookingDetail,
  findCustomer,
  insertBookingWithPayment,
  openRequestCount,
  type Payment,
  slotTaken,
  updateBookingFrom,
} from "../data/bookings.ts";
import { chargerRules } from "../data/listing.ts";
import { updateBookingWithRefund } from "../data/payments.ts";
import { HttpProblem } from "../http/problem.ts";
import { queueNotification } from "../notifications/queue.ts";
import { captureHold, chargeBooking, releaseHold, sendRefund } from "../payments/charges.ts";
import type { Services } from "../services.ts";
import { expireRequestJob, noShowJob, resumePaymentJob } from "./jobs.ts";
import {
  coveringRule,
  isSlotTaken,
  localDay,
  MAX_OPEN_REQUESTS,
  MIN_CHARGE_CENTS,
  newIdTag,
  windowProblem,
} from "./rules.ts";

// The booking lifecycle, paid upfront: an instant booking is charged in full
// when it is made; a request holds the price on the card until the host
// approves (captured) or declines or lets it expire (released). Cancelling
// refunds by fixed rules. Every change first claims the booking's status
// transition (a guarded update, so a racing change loses cleanly) and only
// then moves money; a Stripe call that fails half way is resumed by
// `resumePayment` from what the rows say.

const notFound = () => new HttpProblem(404, "booking-not-found", "No such booking");

const slotTakenProblem = () =>
  new HttpProblem(
    409,
    "slot-taken",
    "This slot is already booked",
    "Another booking holds part of this time. Pick another slot.",
  );

export interface BookingRequest {
  readonly driverId: string;
  readonly chargerId: string;
  readonly window: { readonly start: Date; readonly end: Date };
  readonly vehiclePlate: string;
  readonly paymentMethodId: string | undefined;
}

/** The card a booking is paid with: the one asked for, or the driver's default. */
async function chooseCard(
  services: Services,
  driverId: string,
  paymentMethodId: string | undefined,
): Promise<{ customerId: string; paymentMethodId: string }> {
  const customer = await findCustomer(services.db, driverId);
  const customerId = customer?.stripeCustomerId ?? null;
  const missing = new HttpProblem(
    422,
    "payment-method-required",
    "Add a card first",
    "Save a card with POST /me/payment-methods/setup-intent, then book again.",
  );
  if (customerId === null) throw missing;
  if (paymentMethodId !== undefined) {
    const card = await services.payments.findCard(customerId, paymentMethodId);
    if (card === undefined) {
      throw new HttpProblem(
        422,
        "payment-method-invalid",
        "That card is not saved on your account",
      );
    }
    return { customerId, paymentMethodId };
  }
  const { defaultCardId } = await services.payments.listCards(customerId);
  if (defaultCardId === null) throw missing;
  return { customerId, paymentMethodId: defaultCardId };
}

/** How long to wait before resuming a payment whose outcome Stripe did not give. */
const RESUME_DELAY_MS = 60_000;

/** Queues `resumePayment` for a payment left half way. Never throws: the sweep catches up. */
export async function queueResume(services: Services, paymentId: string): Promise<void> {
  try {
    await services.jobs.send(
      resumePaymentJob,
      { paymentId },
      {
        singletonKey: paymentId,
        startAfter: new Date(services.clock.now().getTime() + RESUME_DELAY_MS),
      },
    );
  } catch (error) {
    services.log.warn({ paymentId, err: error }, "queueing a payment resume failed");
  }
}

/** Cancels a booking whose payment could not be taken, recording why, and tells both sides. */
export async function cancelForPayment(
  services: Services,
  bookingId: string,
  reason: string,
): Promise<boolean> {
  const changed = await updateBookingFrom(services.db, bookingId, ["requested", "confirmed"], {
    status: "cancelled",
    cancelledAt: services.clock.now(),
    cancelledBy: "system",
    cancellationReason: `payment_failed: ${reason}`,
  });
  if (changed) await queueNotification(services, { type: "booking_cancelled", bookingId });
  return changed;
}

/** Queues what follows a booking reaching `status`: a no-show check, or a request's expiry. */
async function scheduleFollowUp(
  services: Services,
  bookingId: string,
  status: "requested" | "confirmed",
  booking: { slot: { start: Date; end: Date }; createdAt: Date },
): Promise<void> {
  if (status === "confirmed") {
    await services.jobs.send(
      noShowJob,
      { bookingId },
      { startAfter: noShowAt(booking.slot.end), singletonKey: bookingId },
    );
  } else {
    await services.jobs.send(
      expireRequestJob,
      { bookingId },
      {
        startAfter: requestExpiresAt(booking.createdAt, booking.slot.start),
        singletonKey: bookingId,
      },
    );
  }
}

const hostCannotTakePayments = () =>
  new HttpProblem(
    409,
    "charger-unavailable",
    "This charger is not taking bookings right now",
    "The host has not finished setting up payouts.",
  );

/**
 * Books a slot: checks the charger is listed, the window sits inside one
 * availability window and the driver has room for another request, then
 * inserts the booking under the host's daily cap (confirmed with an idTag on
 * instant book, otherwise requested) and charges the price upfront: in full
 * for an instant booking, held on the card for a request. An overlap is
 * refused before any call to Stripe; a declined card cancels the booking.
 */
export async function createBooking(services: Services, request: BookingRequest): Promise<string> {
  const { db, clock } = services;
  const now = clock.now();
  const { window } = request;
  const charger = await findBookableCharger(db, request.chargerId);
  if (charger === undefined) {
    throw new HttpProblem(404, "charger-not-found", "No such charger");
  }
  if (charger.hostUserId === request.driverId) {
    throw new HttpProblem(409, "own-charger", "You cannot book your own charger");
  }
  if (charger.status !== "online" || !charger.acceptingBookings) {
    throw new HttpProblem(
      409,
      "charger-unavailable",
      "This charger is not taking bookings right now",
    );
  }
  const destination = charger.stripeAccountId;
  if (destination === null || charger.payoutStatus !== "enabled") throw hostCannotTakePayments();
  const shape = windowProblem(window, now, services.timings.minBookingMinutes);
  if (shape !== undefined) {
    throw new HttpProblem(422, "invalid-slot", "This slot cannot be booked", shape);
  }
  const rule = coveringRule(await chargerRules(db, charger.id), window, charger.timezone);
  if (rule === undefined) {
    throw new HttpProblem(
      422,
      "outside-availability",
      "The charger is not available for this whole slot",
      "Pick a slot inside one of the host's availability windows.",
    );
  }
  if (!rule.instantBook && (await openRequestCount(db, request.driverId)) >= MAX_OPEN_REQUESTS) {
    throw new HttpProblem(
      409,
      "too-many-requests",
      "You have too many requests waiting",
      `Wait for a host to answer, or cancel a request: at most ${String(MAX_OPEN_REQUESTS)} can wait at once.`,
    );
  }
  if (await slotTaken(db, charger.id, window)) throw slotTakenProblem();

  const priceCents = quote(window, rule.pricePerHourCents);
  if (priceCents < MIN_CHARGE_CENTS) {
    throw new HttpProblem(
      422,
      "amount-too-small",
      "This booking is too short to pay for",
      `The smallest card payment is ${String(MIN_CHARGE_CENTS)} cents.`,
    );
  }
  const card = await chooseCard(services, request.driverId, request.paymentMethodId);
  const split = chargeSplit(priceCents, services.fees);

  const status = rule.instantBook ? "confirmed" : "requested";
  const inserted = await insertBookingWithPayment(
    db,
    {
      chargerId: charger.id,
      driverId: request.driverId,
      slot: { start: window.start, end: window.end },
      status,
      idTag: status === "confirmed" ? newIdTag() : null,
      quotedAmountCents: priceCents,
      pricePerHourCents: rule.pricePerHourCents,
      currency: rule.currency,
      kwhCap: rule.kwhCap,
      vehiclePlate: request.vehiclePlate,
    },
    {
      paymentMethodId: card.paymentMethodId,
      amountCents: split.amountCents,
      platformFeeCents: split.platformFeeCents,
      cardFeeCents: split.cardFeeCents,
      captureMethod: status === "confirmed" ? "automatic" : "manual",
    },
    {
      hostId: charger.hostId,
      day: localDay(window.start, charger.timezone),
      maxSessionsPerDay: charger.maxSessionsPerDay,
    },
  );
  if (inserted === "slot-taken") throw slotTakenProblem();
  if (inserted === "host-day-full") {
    throw new HttpProblem(
      409,
      "host-day-full",
      "The host takes no more bookings that day",
      `This host accepts at most ${String(charger.maxSessionsPerDay)} sessions a day.`,
    );
  }
  const { bookingId } = inserted;
  const detail = await findBookingDetail(db, bookingId);
  const payment = detail?.payment ?? null;
  if (detail === undefined || payment === null) throw new Error(`booking ${bookingId} not saved`);

  const outcome = await chargeBooking(services, payment, {
    customerId: card.customerId,
    destination,
  });
  if (outcome === "failed") {
    await cancelForPayment(services, bookingId, "card_declined");
    throw new HttpProblem(
      402,
      "payment-declined",
      "The card was declined",
      "Nothing was charged. Use another card, or check this one with your bank.",
    );
  }
  if (outcome === "unknown" || outcome === "pending") await queueResume(services, payment.id);
  await scheduleFollowUp(services, bookingId, status, detail.booking);
  await queueNotification(services, { type: "booking_created", bookingId });
  return bookingId;
}

/** The booking, if the user is the host of its charger; otherwise 404. */
async function hostsBooking(
  services: Services,
  userId: string,
  bookingId: string,
): Promise<BookingDetail> {
  const detail = await findBookingDetail(services.db, bookingId);
  if (detail?.host.userId !== userId) throw notFound();
  return detail;
}

const notRequested = () =>
  new HttpProblem(409, "not-requested", "Only a booking awaiting approval can be answered");

const paymentInProgress = () =>
  new HttpProblem(
    409,
    "payment-in-progress",
    "The payment for this booking is still going through",
    "Try again in a minute.",
  );

/**
 * The host accepts a request: the booking is confirmed (its idTag issued),
 * then the held price is captured. A hold that has lapsed cancels the
 * booking (402); a capture Stripe did not answer is resumed later, and the
 * driver cannot start charging until it has gone through.
 */
export async function approveBooking(
  services: Services,
  userId: string,
  bookingId: string,
): Promise<void> {
  const detail = await hostsBooking(services, userId, bookingId);
  if (detail.booking.status !== "requested") throw notRequested();
  const payment = detail.payment;
  if (payment?.status !== "authorised") throw paymentInProgress();
  let changed: boolean;
  try {
    changed = await updateBookingFrom(services.db, bookingId, ["requested"], {
      status: "confirmed",
      idTag: newIdTag(),
    });
  } catch (error) {
    if (isSlotTaken(error)) throw slotTakenProblem();
    throw error;
  }
  if (!changed) throw notRequested();
  const outcome = await captureHold(services, payment);
  if (outcome === "failed") {
    await cancelForPayment(services, bookingId, "authorisation_expired");
    throw new HttpProblem(
      402,
      "payment-failed",
      "The driver's payment could not be taken",
      "The hold on the driver's card had lapsed, so the booking was cancelled.",
    );
  }
  if (outcome === "unknown") await queueResume(services, payment.id);
  await scheduleFollowUp(services, bookingId, "confirmed", detail.booking);
  await queueNotification(services, { type: "booking_approved", bookingId });
}

/** Releases a request's hold after the booking was cancelled; resumes it later if that fails. */
async function letGoOfHold(services: Services, payment: Payment | null): Promise<void> {
  if (payment === null) return;
  const outcome = await releaseHold(services, payment);
  if (outcome === "unknown") await queueResume(services, payment.id);
}

/** The host turns a request down: the booking is cancelled, then the hold released. */
export async function declineBooking(
  services: Services,
  userId: string,
  bookingId: string,
  reason: string | undefined,
): Promise<void> {
  const detail = await hostsBooking(services, userId, bookingId);
  if (detail.booking.status !== "requested") throw notRequested();
  const changed = await updateBookingFrom(services.db, bookingId, ["requested"], {
    status: "cancelled",
    cancelledAt: services.clock.now(),
    cancelledBy: "host",
    cancellationReason: reason ?? "declined",
  });
  if (!changed) throw notRequested();
  await letGoOfHold(services, detail.payment);
  await queueNotification(services, { type: "booking_declined", bookingId });
}

/**
 * Cancels a booking for its driver or host. A request's hold is released. A
 * confirmed booking is refunded in full when the host cancels or the driver
 * cancels before the host's cutoff (default 2 hours before the start), and
 * not at all when the driver cancels after it. The cancellation and the
 * refund it owes are saved together, then the refund is sent. Nothing can be
 * cancelled once the driver has arrived.
 */
export async function cancelBooking(
  services: Services,
  userId: string,
  bookingId: string,
  reason: string | undefined,
): Promise<void> {
  const detail = await findBookingDetail(services.db, bookingId);
  const role =
    detail?.booking.driverId === userId
      ? "driver"
      : detail?.host.userId === userId
        ? "host"
        : undefined;
  if (detail === undefined || role === undefined) throw notFound();
  const { booking, payment } = detail;
  if (!isCancellable(booking.status)) {
    throw new HttpProblem(
      409,
      "cannot-cancel",
      "This booking can no longer be cancelled",
      booking.status === "arrived" || booking.status === "active"
        ? "A session that has started can only be stopped."
        : undefined,
    );
  }
  const now = services.clock.now();
  const cancellation: BookingChange = {
    status: "cancelled",
    cancelledAt: now,
    cancelledBy: role,
    cancellationReason: reason ?? `cancelled_by_${role}`,
  };
  const cannotCancel = () =>
    new HttpProblem(409, "cannot-cancel", "This booking can no longer be cancelled");

  if (booking.status === "requested") {
    if (!(await updateBookingFrom(services.db, bookingId, ["requested"], cancellation))) {
      throw cannotCancel();
    }
    await letGoOfHold(services, payment);
    await queueNotification(services, { type: "booking_cancelled", bookingId });
    return;
  }

  if (payment?.status !== "paid") throw paymentInProgress();
  const { refundCents } = cancellationRefund(
    { cutoffMinutes: detail.host.cancellationCutoffMinutes, paidCents: payment.amountCents },
    role,
    now,
    booking.slot.start,
  );
  const { changed, refund } = await updateBookingWithRefund(
    services.db,
    bookingId,
    ["confirmed"],
    cancellation,
    refundCents === 0
      ? undefined
      : {
          // Everything paid, less any earlier (support) refund.
          paymentId: payment.id,
          amountCents: "remainder",
          reason: role === "driver" ? "driver_cancelled" : "host_cancelled",
        },
  );
  if (!changed) throw cannotCancel();
  if (refund !== undefined && (await sendRefund(services, payment, refund)) === "pending") {
    await queueResume(services, payment.id);
  }
  await queueNotification(services, { type: "booking_cancelled", bookingId });
}

/**
 * The no-show job, at slot end + 15 minutes: a booking still confirmed (the
 * driver never arrived) becomes a no-show. The driver paid upfront and is not
 * refunded.
 */
export async function markNoShow(services: Services, bookingId: string): Promise<void> {
  const detail = await findBookingDetail(services.db, bookingId);
  if (detail?.booking.status !== "confirmed") return;
  if (services.clock.now().getTime() < noShowAt(detail.booking.slot.end).getTime()) return;
  if (await updateBookingFrom(services.db, bookingId, ["confirmed"], { status: "no_show" })) {
    services.log.info({ bookingId }, "booking marked no-show; not refunded");
  }
}

/**
 * The expiry job: a request the host has not answered within 24 hours (or
 * by the slot start, if sooner) is cancelled, then its hold released.
 */
export async function expireRequest(services: Services, bookingId: string): Promise<void> {
  const detail = await findBookingDetail(services.db, bookingId);
  if (detail?.booking.status !== "requested") return;
  const { booking } = detail;
  if (services.clock.now() < requestExpiresAt(booking.createdAt, booking.slot.start)) return;
  const changed = await updateBookingFrom(services.db, bookingId, ["requested"], {
    status: "cancelled",
    cancelledAt: services.clock.now(),
    cancelledBy: "system",
    cancellationReason: "host_did_not_respond",
  });
  if (!changed) return;
  await letGoOfHold(services, detail.payment);
  await queueNotification(services, { type: "booking_expired", bookingId });
}
