import { noShowFee, staleSessionCloseAt } from "@nd/domain";

import { hostTransferJob } from "../bookings/jobs.ts";
import { hourlyPriceOf } from "../bookings/rules.ts";
import { findBookingDetail, updateBookingFrom } from "../data/bookings.ts";
import { billedSessionOf, hasAnySession } from "../data/settlement.ts";
import { captureForBooking, releaseCardHold } from "../payments/settlement.ts";
import type { SettlementServices } from "./services.ts";

// A driver who checked in ("I'm here") but never got a charging session
// would leave the booking `arrived` forever. 10 minutes after the slot ends:
// - if a start was tried (a failed session) or the car plugged in, the
//   booking is `completed` with nothing billed: the failure may well be the
//   charger's, so the authorisation is released;
// - otherwise the driver never plugged in, and the no-show rule applies: one
//   hour at the hourly price, capped at the quote, paid to the host.

/** What closing an arrival did. */
export type ArrivalOutcome = "completed" | "no_show" | "skipped";

export async function closeArrivedBooking(
  services: SettlementServices,
  bookingId: string,
): Promise<ArrivalOutcome> {
  const detail = await findBookingDetail(services.db, bookingId);
  if (detail?.booking.status !== "arrived") return "skipped";
  const { booking, payment } = detail;
  if (services.clock.now() < staleSessionCloseAt(booking.slot.end)) return "skipped";
  // A session that started is settled by reconciliation, not here.
  if ((await billedSessionOf(services.db, bookingId)) !== undefined) return "skipped";

  const attempted = booking.pluggedInAt !== null || (await hasAnySession(services.db, bookingId));
  if (attempted) {
    await releaseCardHold(services, bookingId, payment);
    await updateBookingFrom(services.db, bookingId, ["arrived"], { status: "completed" });
    services.realtime.bookingChanged(bookingId);
    return "completed";
  }
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
    await releaseCardHold(services, bookingId, payment);
  }
  await updateBookingFrom(services.db, bookingId, ["arrived"], {
    status: "no_show",
    cancellationFeeCents: fee,
  });
  services.realtime.bookingChanged(bookingId);
  return "no_show";
}
