import { hostTransferJob } from "../bookings/jobs.ts";
import {
  arrivedWithoutSession,
  capturedWithoutTransfer,
  releasableHeldTransfers,
  sessionsToReconcile,
  staleOpenSessions,
} from "../data/settlement.ts";
import type { Services } from "../services.ts";
import {
  closeArrivedBookingJob,
  closeStaleSessionJob,
  reconcileSessionJob,
  releaseHeldTransfersJob,
} from "./jobs.ts";

// The safety net under event-driven settlement. NOTIFY is not durable and the
// API may be down when a session stops, so every minute this queues whatever
// is due: sessions to reconcile, sessions with no StopTransaction to close,
// arrivals that never got a session,
// captured payments without a transfer, and held transfers that may go out.
// Each job is keyed by what it is about, so nothing is queued twice.

/** Most rows of each kind one sweep queues. */
const SWEEP_BATCH = 200;

/** How many jobs of each kind a sweep queued. */
export interface SweepResult {
  readonly reconcile: number;
  readonly closeStale: number;
  readonly closeArrived: number;
  readonly transfer: number;
  readonly release: number;
}

export async function settlementSweep(services: Services): Promise<SweepResult> {
  const { db, jobs } = services;
  const now = services.clock.now();
  const cutoff = new Date(now.getTime() - services.timings.staleSessionGraceMinutes * 60_000);

  const toReconcile = await sessionsToReconcile(db, now, SWEEP_BATCH);
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
  const untransferred = await capturedWithoutTransfer(db, SWEEP_BATCH);
  for (const paymentId of untransferred) {
    await jobs.send(hostTransferJob, { paymentId }, { singletonKey: paymentId });
  }
  const held = await releasableHeldTransfers(db, { limit: SWEEP_BATCH });
  const hosts = [...new Set(held.map((row) => row.hostId))];
  for (const hostId of hosts) {
    await jobs.send(releaseHeldTransfersJob, { hostId }, { singletonKey: hostId });
  }
  return {
    reconcile: toReconcile.length,
    closeStale: stale.length,
    closeArrived: arrived.length,
    transfer: untransferred.length,
    release: hosts.length,
  };
}
