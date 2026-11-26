import {
  authorisationPlan,
  cancellationFee,
  isCancellable,
  noShowAt,
  noShowFee,
  quote,
} from "@nd/domain";

import {
  type BookingDetail,
  findBookableCharger,
  findBookingDetail,
  findCustomer,
  hostBookingsStarting,
  insertBookingWithPayment,
  slotTaken,
  updateBookingFrom,
  updatePaymentFrom,
} from "../data/bookings.ts";
import { chargerRules } from "../data/listing.ts";
import { HttpProblem } from "../http/problem.ts";
import type { JobAttempt } from "../jobs/jobs.ts";
import { captureForBooking, paymentKeys, releaseAuthorisation } from "../payments/settlement.ts";
import type { Services } from "../services.ts";
import { authoriseBookingJob, expireRequestJob, hostTransferJob, noShowJob } from "./jobs.ts";
import {
  coveringRule,
  hourlyPriceOf,
  isSlotTaken,
  localDay,
  MIN_CHARGE_CENTS,
  newIdTag,
  windowProblem,
} from "./rules.ts";

// The booking lifecycle: request or instant confirmation with payment,
// host approval and decline, cancellation under the host's policy, and the
// jobs that authorise saved cards, expire unanswered requests and mark
// no-shows. Status changes are checked against @nd/domain's transition
// tables by only updating rows still in the expected status.

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

/** Cancels a booking whose payment could not be secured, recording why. */
async function cancelForPayment(
  services: Services,
  bookingId: string,
  paymentId: string,
  reason: string,
): Promise<void> {
  await updatePaymentFrom(services.db, paymentId, ["pending_authorisation", "card_saved"], {
    status: "failed",
    failureReason: reason,
  });
  await updateBookingFrom(services.db, bookingId, ["requested", "confirmed"], {
    status: "cancelled",
    cancelledAt: services.clock.now(),
    cancelledBy: "system",
    cancellationReason: `payment_failed: ${reason}`,
  });
}

/** Queues what follows a booking reaching `status`: a no-show check, or a request's expiry. */
async function scheduleFollowUp(
  services: Services,
  bookingId: string,
  status: "requested" | "confirmed",
  slot: { start: Date; end: Date },
): Promise<void> {
  if (status === "confirmed") {
    await services.jobs.send(
      noShowJob,
      { bookingId },
      { startAfter: noShowAt(slot.end), singletonKey: bookingId },
    );
  } else {
    await services.jobs.send(
      expireRequestJob,
      { bookingId },
      { startAfter: slot.start, singletonKey: bookingId },
    );
  }
}

/**
 * Books a slot: checks the charger is listed and the window sits inside one
 * availability window and under the host's daily cap, then inserts the
 * booking (confirmed with an idTag on instant book, otherwise requested) and
 * secures payment. An overlap is refused before any call to Stripe.
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
  const shape = windowProblem(window, now);
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
  const day = localDay(window.start, charger.timezone);
  if ((await hostBookingsStarting(db, charger.hostId, day)) >= charger.maxSessionsPerDay) {
    throw new HttpProblem(
      409,
      "host-day-full",
      "The host takes no more bookings that day",
      `This host accepts at most ${String(charger.maxSessionsPerDay)} sessions a day.`,
    );
  }
  if (await slotTaken(db, charger.id, window)) throw slotTakenProblem();

  const quotedAmountCents = quote(window, rule.pricePerHourCents);
  if (quotedAmountCents < MIN_CHARGE_CENTS) {
    throw new HttpProblem(
      422,
      "amount-too-small",
      "This booking is too short to pay for",
      `The smallest card payment is ${String(MIN_CHARGE_CENTS)} cents.`,
    );
  }
  const card = await chooseCard(services, request.driverId, request.paymentMethodId);

  const status = rule.instantBook ? "confirmed" : "requested";
  const inserted = await insertBookingWithPayment(db, {
    chargerId: charger.id,
    driverId: request.driverId,
    slot: { start: window.start, end: window.end },
    status,
    idTag: status === "confirmed" ? newIdTag() : null,
    quotedAmountCents,
    pricePerHourCents: rule.pricePerHourCents,
    currency: rule.currency,
    kwhCap: rule.kwhCap,
    vehiclePlate: request.vehiclePlate,
    paymentMethodId: card.paymentMethodId,
  });
  if (inserted === undefined) throw slotTakenProblem();
  const { bookingId, paymentId } = inserted;

  const plan = authorisationPlan(now, window.start);
  if (plan.kind === "save_card") {
    await updatePaymentFrom(db, paymentId, ["pending_authorisation"], {
      status: "card_saved",
      authoriseAt: plan.authoriseAt,
    });
    await services.jobs.send(
      authoriseBookingJob,
      { bookingId },
      { startAfter: plan.authoriseAt, singletonKey: bookingId },
    );
  } else {
    let result;
    try {
      result = await services.payments.authorise({
        bookingId,
        amountCents: quotedAmountCents,
        currency: rule.currency,
        customerId: card.customerId,
        paymentMethodId: card.paymentMethodId,
        idempotencyKey: paymentKeys.authorise(bookingId),
      });
    } catch (error) {
      await cancelForPayment(services, bookingId, paymentId, "provider_error");
      if (error instanceof HttpProblem) throw error;
      services.log.error({ bookingId, err: error }, "authorising a booking failed");
      throw new HttpProblem(
        502,
        "payment-provider-error",
        "Payment could not be taken",
        "The payment provider did not answer. Nothing was charged; try again.",
      );
    }
    if (result.status === "failed") {
      await cancelForPayment(services, bookingId, paymentId, result.reason);
      throw new HttpProblem(
        402,
        "payment-declined",
        "The card was declined",
        "Nothing was charged. Use another card, or check this one with your bank.",
      );
    }
    await updatePaymentFrom(db, paymentId, ["pending_authorisation"], {
      status: "authorised",
      stripePaymentIntentId: result.paymentIntentId,
      authorisedCents: result.amountCents,
    });
  }
  await scheduleFollowUp(services, bookingId, status, window);
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

/** The host accepts a request: the booking is confirmed and its idTag issued. */
export async function approveBooking(
  services: Services,
  userId: string,
  bookingId: string,
): Promise<void> {
  const detail = await hostsBooking(services, userId, bookingId);
  if (detail.booking.status !== "requested") throw notRequested();
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
  await scheduleFollowUp(services, bookingId, "confirmed", detail.booking.slot);
}

/** The host turns a request down: the booking is cancelled and the authorisation released. */
export async function declineBooking(
  services: Services,
  userId: string,
  bookingId: string,
  reason: string | undefined,
): Promise<void> {
  const detail = await hostsBooking(services, userId, bookingId);
  if (detail.booking.status !== "requested") throw notRequested();
  await releaseAuthorisation(services, bookingId, detail.payment);
  const changed = await updateBookingFrom(services.db, bookingId, ["requested"], {
    status: "cancelled",
    cancelledAt: services.clock.now(),
    cancelledBy: "host",
    cancellationReason: reason ?? "declined",
  });
  if (!changed) throw notRequested();
}

/**
 * Cancels a booking for its driver or host. A driver cancelling a confirmed
 * booking after the host's cutoff pays the fee (one hour, capped at the
 * quote), captured from the authorisation; otherwise the authorisation is
 * released. Nothing can be cancelled once the driver has arrived.
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
  const charge =
    role === "driver" && booking.status === "confirmed"
      ? cancellationFee(
          {
            cutoffMinutes: detail.host.cancellationCutoffMinutes,
            pricePerHourCents: hourlyPriceOf(booking),
            quoteCents: booking.quotedAmountCents,
          },
          now,
          booking.slot.start,
        ).feeCents
      : 0;
  // A fee is only taken from an authorisation; without one, cancelling is free.
  const fee = payment?.status === "authorised" ? charge : 0;
  if (fee > 0) {
    const captured = await captureForBooking(services, bookingId, fee);
    await services.jobs.send(
      hostTransferJob,
      { paymentId: captured.paymentId },
      { singletonKey: captured.paymentId },
    );
  } else {
    await releaseAuthorisation(services, bookingId, payment);
  }
  const changed = await updateBookingFrom(services.db, bookingId, [booking.status], {
    status: "cancelled",
    cancelledAt: now,
    cancelledBy: role,
    cancellationReason: reason ?? `cancelled_by_${role}`,
    cancellationFeeCents: fee,
  });
  if (!changed) {
    throw new HttpProblem(409, "cannot-cancel", "This booking can no longer be cancelled");
  }
}

/**
 * The authorisation job: authorises a saved card off-session 24 hours before
 * the slot. Does nothing unless the booking is still live and the payment is
 * still waiting. A decline is retried; after the last attempt the booking is
 * cancelled at no charge with the decline recorded.
 */
export async function authoriseSavedCard(
  services: Services,
  bookingId: string,
  attempt: JobAttempt,
): Promise<void> {
  const detail = await findBookingDetail(services.db, bookingId);
  const payment = detail?.payment ?? null;
  if (detail === undefined || payment === null) return;
  if (!isCancellable(detail.booking.status) || payment.status !== "card_saved") return;
  const customerId = detail.driver.stripeCustomerId;
  const paymentMethodId = payment.stripePaymentMethodId;
  if (customerId === null || paymentMethodId === null) {
    await cancelForPayment(services, bookingId, payment.id, "no_saved_card");
    return;
  }
  let result;
  try {
    result = await services.payments.authorise({
      bookingId,
      amountCents: detail.booking.quotedAmountCents,
      currency: detail.booking.currency,
      customerId,
      paymentMethodId,
      // A decline is remembered under its key, so each attempt has its own.
      idempotencyKey: paymentKeys.authoriseAttempt(bookingId, attempt.retryCount),
    });
  } catch (error) {
    if (!attempt.lastAttempt) throw error;
    result = { status: "failed", paymentIntentId: null, reason: "provider_error" } as const;
  }
  if (result.status === "authorised") {
    await updatePaymentFrom(services.db, payment.id, ["card_saved"], {
      status: "authorised",
      stripePaymentIntentId: result.paymentIntentId,
      authorisedCents: result.amountCents,
      failureReason: null,
    });
    return;
  }
  if (!attempt.lastAttempt) {
    await updatePaymentFrom(services.db, payment.id, ["card_saved"], {
      failureReason: result.reason,
    });
    throw new Error(`authorising booking ${bookingId} was declined: ${result.reason}`);
  }
  await cancelForPayment(services, bookingId, payment.id, result.reason);
}

/**
 * The no-show job, at slot end + 15 minutes: a booking still confirmed (the
 * driver never arrived) becomes a no-show and pays the no-show fee from its
 * authorisation; the rest is released.
 */
export async function markNoShow(services: Services, bookingId: string): Promise<void> {
  const detail = await findBookingDetail(services.db, bookingId);
  if (detail?.booking.status !== "confirmed") return;
  const { booking, payment } = detail;
  if (services.clock.now().getTime() < noShowAt(booking.slot.end).getTime()) return;
  const fee =
    payment?.status === "authorised"
      ? noShowFee({
          pricePerHourCents: hourlyPriceOf(booking),
          quoteCents: booking.quotedAmountCents,
        })
      : 0;
  if (fee > 0) {
    const captured = await captureForBooking(services, bookingId, fee);
    await services.jobs.send(
      hostTransferJob,
      { paymentId: captured.paymentId },
      { singletonKey: captured.paymentId },
    );
  } else {
    await releaseAuthorisation(services, bookingId, payment);
  }
  await updateBookingFrom(services.db, bookingId, ["confirmed"], {
    status: "no_show",
    cancellationFeeCents: fee,
  });
}

/**
 * The expiry job, at slot start: a request the host has not answered is
 * cancelled and its authorisation released.
 */
export async function expireRequest(services: Services, bookingId: string): Promise<void> {
  const detail = await findBookingDetail(services.db, bookingId);
  if (detail?.booking.status !== "requested") return;
  if (services.clock.now().getTime() < detail.booking.slot.start.getTime()) return;
  await releaseAuthorisation(services, bookingId, detail.payment);
  await updateBookingFrom(services.db, bookingId, ["requested"], {
    status: "cancelled",
    cancelledAt: services.clock.now(),
    cancelledBy: "system",
    cancellationReason: "host_did_not_respond",
  });
}
