import { staleSessionCloseAt } from "@nd/domain";

import { queueResume } from "../bookings/lifecycle.ts";
import { findBookingDetail, updateBookingFrom } from "../data/bookings.ts";
import { updateBookingWithRefund } from "../data/payments.ts";
import { billedSessionOf, hasAnySession } from "../data/settlement.ts";
import { sendRefund } from "../payments/charges.ts";
import type { SettlementServices } from "./services.ts";

// A driver who checked in ("I'm here") but never got a charging session
// would leave the booking `arrived` forever. A few minutes after the slot:
// - if a start was tried (it failed), the car was plugged in, or the charger
//   is not online, the charger let the driver down: the booking is
//   `completed` and refunded in full, automatically;
// - otherwise the driver never plugged in: a no-show, not refunded.

/** What closing an arrival did. */
export type ArrivalOutcome = "refunded" | "no_show" | "skipped";

export async function closeArrivedBooking(
  services: SettlementServices,
  bookingId: string,
): Promise<ArrivalOutcome> {
  const detail = await findBookingDetail(services.db, bookingId);
  if (detail?.booking.status !== "arrived") return "skipped";
  const { booking, payment, charger } = detail;
  const closeAt = staleSessionCloseAt(booking.slot.end, services.timings.staleSessionGraceMinutes);
  if (services.clock.now() < closeAt) return "skipped";
  // A session that started is closed by reconciliation, not here.
  if ((await billedSessionOf(services.db, bookingId)) !== undefined) return "skipped";

  const chargerFault =
    booking.pluggedInAt !== null ||
    charger.status !== "online" ||
    (await hasAnySession(services.db, bookingId));
  if (!chargerFault) {
    await updateBookingFrom(services.db, bookingId, ["arrived"], { status: "no_show" });
    services.realtime.bookingChanged(bookingId);
    return "no_show";
  }
  const { changed, refund } = await updateBookingWithRefund(
    services.db,
    bookingId,
    ["arrived"],
    { status: "completed" },
    payment?.status === "paid"
      ? { paymentId: payment.id, amountCents: payment.amountCents, reason: "charger_fault" }
      : undefined,
  );
  if (!changed) return "skipped";
  services.realtime.bookingChanged(bookingId);
  if (refund !== undefined && payment !== null) {
    if ((await sendRefund(services, payment, refund)) === "pending") {
      await queueResume(services, payment.id);
    }
  }
  services.log.info({ bookingId }, "charger never charged an arrived driver; refunded in full");
  return "refunded";
}
