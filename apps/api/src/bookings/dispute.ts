import { TERMINAL_BOOKING_STATUSES } from "@nd/domain";

import { findBookingDetail } from "../data/bookings.ts";
import { insertDisputeOnce } from "../data/disputes.ts";
import { HttpProblem } from "../http/problem.ts";
import type { Services } from "../services.ts";

// A driver disputes what happened on a finished booking (a charge, a no-show
// fee, a session that went wrong). The dispute is recorded for support; this
// does not move money.

/** The driver raises a dispute on one of their finished bookings; resolves to its id. */
export async function disputeBooking(
  services: Services,
  driverId: string,
  bookingId: string,
  input: { reason: string; details: string | null },
): Promise<string> {
  const detail = await findBookingDetail(services.db, bookingId);
  if (
    detail === undefined ||
    (detail.booking.driverId !== driverId && detail.host.userId !== driverId)
  ) {
    throw new HttpProblem(404, "booking-not-found", "No such booking");
  }
  if (detail.booking.driverId !== driverId) {
    throw new HttpProblem(403, "driver-only", "Only the driver can dispute a booking");
  }
  if (!(TERMINAL_BOOKING_STATUSES as readonly string[]).includes(detail.booking.status)) {
    throw new HttpProblem(
      409,
      "booking-not-finished",
      "You can dispute a booking once it has finished",
    );
  }
  const disputeId = await insertDisputeOnce(services.db, {
    bookingId,
    raisedById: driverId,
    reason: input.reason,
    details: input.details,
  });
  if (disputeId === undefined) {
    throw new HttpProblem(
      409,
      "already-disputed",
      "You already have an open dispute on this booking",
    );
  }
  services.log.warn({ bookingId, disputeId }, "driver disputed a booking; needs support");
  return disputeId;
}
