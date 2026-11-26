import { findBookingDetail } from "../data/bookings.ts";
import { findReview, insertReview } from "../data/settlement.ts";
import { HttpProblem } from "../http/problem.ts";
import type { Services } from "../services.ts";

// After a completed booking the driver rates the host once, 1 to 5 with an
// optional comment. Listings average these ratings.

/** A saved review. */
export interface ReviewView {
  readonly rating: number;
  readonly comment: string | null;
  readonly createdAt: string;
}

/** The driver rates the host of a completed booking; only once. */
export async function reviewBooking(
  services: Services,
  driverId: string,
  bookingId: string,
  input: { rating: number; comment: string | null },
): Promise<ReviewView> {
  const detail = await findBookingDetail(services.db, bookingId);
  if (
    detail === undefined ||
    (detail.booking.driverId !== driverId && detail.host.userId !== driverId)
  ) {
    throw new HttpProblem(404, "booking-not-found", "No such booking");
  }
  if (detail.booking.driverId !== driverId) {
    throw new HttpProblem(403, "driver-only", "Only the driver can review a booking");
  }
  if (detail.booking.status !== "completed") {
    throw new HttpProblem(
      409,
      "booking-not-completed",
      "You can review a booking once it is completed",
    );
  }
  const saved = await insertReview(services.db, {
    bookingId,
    reviewerId: driverId,
    revieweeId: detail.host.userId,
    rating: input.rating,
    comment: input.comment,
  });
  if (!saved)
    throw new HttpProblem(409, "already-reviewed", "You have already reviewed this booking");
  const review = await findReview(services.db, bookingId, driverId);
  if (review === undefined) throw new Error("review not saved");
  return {
    rating: review.rating,
    comment: review.comment,
    createdAt: review.createdAt.toISOString(),
  };
}
