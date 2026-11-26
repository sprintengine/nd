import { z } from "zod";

import { type AnyJob, defineJob } from "../jobs/jobs.ts";
import { createHostTransfer } from "../payments/settlement.ts";
import type { Services } from "../services.ts";
import { authoriseSavedCard, expireRequest, markNoShow } from "./lifecycle.ts";

const bookingPayload = z.object({ bookingId: z.uuid() });

/**
 * Authorises a far-off booking's saved card 24 hours before the slot. A
 * decline is retried with backoff; when the last attempt fails, the booking
 * is cancelled at no charge and the reason recorded.
 */
export const authoriseBookingJob = defineJob({
  name: "authorise-booking",
  payload: bookingPayload,
  retry: { limit: 4, delaySeconds: 600, backoff: true, maxDelaySeconds: 3 * 3600 },
  run: ({ bookingId }, services: Services, attempt) =>
    authoriseSavedCard(services, bookingId, attempt),
});

/** At slot end + 15 minutes: a confirmed booking never arrived at becomes a no-show, and pays the fee. */
export const noShowJob = defineJob({
  name: "booking-no-show",
  payload: bookingPayload,
  retry: { limit: 5, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
  run: ({ bookingId }, services: Services) => markNoShow(services, bookingId),
});

/** At slot start: a request the host never answered is cancelled and its authorisation released. */
export const expireRequestJob = defineJob({
  name: "booking-expire-request",
  payload: bookingPayload,
  retry: { limit: 5, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
  run: ({ bookingId }, services: Services) => expireRequest(services, bookingId),
});

/** Sends (or holds) the host's transfer for a captured payment. */
export const hostTransferJob = defineJob({
  name: "host-transfer",
  payload: z.object({ paymentId: z.uuid() }),
  retry: { limit: 8, delaySeconds: 60, backoff: true, maxDelaySeconds: 6 * 3600 },
  run: async ({ paymentId }, services: Services) => {
    await createHostTransfer(services, paymentId);
  },
});

/** Every job the API runs. */
export const BOOKING_JOBS: readonly AnyJob<Services>[] = [
  authoriseBookingJob,
  noShowJob,
  expireRequestJob,
  hostTransferJob,
];
