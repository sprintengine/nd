import { z } from "zod";

import { type AnyJob, defineJob } from "../jobs/jobs.ts";
import type { Services } from "../services.ts";
import { expireRequest, markNoShow } from "./lifecycle.ts";
import { resumePayment } from "./resume.ts";

const bookingPayload = z.object({ bookingId: z.uuid() });

/** At slot end + 15 minutes: a confirmed booking never arrived at becomes a no-show (not refunded). */
export const noShowJob = defineJob({
  name: "booking-no-show",
  payload: bookingPayload,
  retry: { limit: 5, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
  run: ({ bookingId }, services: Services) => markNoShow(services, bookingId),
});

/** 24 hours after a request (or at its slot start, if sooner): an unanswered request is cancelled and its hold released. */
export const expireRequestJob = defineJob({
  name: "booking-expire-request",
  payload: bookingPayload,
  retry: { limit: 5, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
  run: ({ bookingId }, services: Services) => expireRequest(services, bookingId),
});

/** Finishes a payment that stopped half way: a charge, capture, release or refund Stripe did not answer. */
export const resumePaymentJob = defineJob({
  name: "resume-payment",
  payload: z.object({ paymentId: z.uuid() }),
  retry: { limit: 8, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
  run: async ({ paymentId }, services: Services) => {
    await resumePayment(services, paymentId);
  },
});

/** Every booking job the API runs. */
export const BOOKING_JOBS: readonly AnyJob<Services>[] = [
  noShowJob,
  expireRequestJob,
  resumePaymentJob,
];
