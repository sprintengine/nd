import { NO_SHOW_GRACE_MINUTES, REQUEST_RESPONSE_HOURS } from "@nd/domain";

import { expireRequestJob, noShowJob, resumePaymentJob } from "../bookings/jobs.ts";
import { dueLifecycleBookings, paymentsToResume } from "../data/payments.ts";
import {
  arrivedWithoutSession,
  sessionsToReconcile,
  staleOpenSessions,
} from "../data/settlement.ts";
import type { Services } from "../services.ts";
import { closeArrivedBookingJob, closeStaleSessionJob, reconcileSessionJob } from "./jobs.ts";

// The safety net under event-driven work. NOTIFY is not durable, the API may
// be down when a session stops, and a job may fail to be queued after the
// change that needed it was saved. So every minute this queues whatever is
// due: sessions to reconcile, sessions with no StopTransaction to close,
// arrivals that never got a session, requests past their expiry and
// confirmed bookings past their no-show time whose jobs went missing, and
// payments that stopped half way. Each job is keyed by what it is about, so
// nothing is queued twice.

/** Most rows of each kind one sweep queues. */
const SWEEP_BATCH = 200;

/** A charge whose outcome is not known is resumed once it is this old (its own job runs first). */
const RESUME_AFTER_MS = 2 * 60_000;

/** How many jobs of each kind a sweep queued. */
export interface SweepResult {
  readonly reconcile: number;
  readonly closeStale: number;
  readonly closeArrived: number;
  readonly expire: number;
  readonly noShow: number;
  readonly resume: number;
}

export async function settlementSweep(services: Services): Promise<SweepResult> {
  const { db, jobs } = services;
  const now = services.clock.now();
  const cutoff = new Date(now.getTime() - services.timings.staleSessionGraceMinutes * 60_000);

  const toReconcile = await sessionsToReconcile(db, SWEEP_BATCH);
  for (const sessionId of toReconcile) {
    await jobs.send(reconcileSessionJob, { sessionId }, { singletonKey: sessionId });
  }
  const stale = await staleOpenSessions(db, cutoff, SWEEP_BATCH);
  for (const sessionId of stale) {
    await jobs.send(closeStaleSessionJob, { sessionId }, { singletonKey: sessionId });
  }
  const arrived = await arrivedWithoutSession(db, cutoff, SWEEP_BATCH);
  for (const bookingId of arrived) {
    await jobs.send(closeArrivedBookingJob, { bookingId }, { singletonKey: bookingId });
  }
  const due = await dueLifecycleBookings(db, {
    now,
    requestHours: REQUEST_RESPONSE_HOURS,
    noShowGraceMinutes: NO_SHOW_GRACE_MINUTES,
    limit: SWEEP_BATCH,
  });
  for (const bookingId of due.expire) {
    await jobs.send(expireRequestJob, { bookingId }, { singletonKey: bookingId });
  }
  for (const bookingId of due.noShow) {
    await jobs.send(noShowJob, { bookingId }, { singletonKey: bookingId });
  }
  const resume = await paymentsToResume(db, new Date(now.getTime() - RESUME_AFTER_MS), SWEEP_BATCH);
  for (const paymentId of resume) {
    await jobs.send(resumePaymentJob, { paymentId }, { singletonKey: paymentId });
  }
  return {
    reconcile: toReconcile.length,
    closeStale: stale.length,
    closeArrived: arrived.length,
    expire: due.expire.length,
    noShow: due.noShow.length,
    resume: resume.length,
  };
}
