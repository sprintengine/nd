import { queueResume } from "../bookings/lifecycle.ts";
import { insertRefund } from "../data/payments.ts";
import { chargerFaultedBetween, type SettlementSession } from "../data/settlement.ts";
import { sendRefund } from "../payments/charges.ts";
import type { SettlementServices } from "./services.ts";

// A session that started but delivered nothing because of the charger is
// refunded in full, like an arrival the charger never started. Anything else
// that delivered nothing (the car was full, the driver unplugged) is for
// support.

/** StopTransaction reasons that mean the charger itself ended the session. */
const CHARGER_STOP_REASONS = ["PowerLoss", "Reboot", "HardReset", "SoftReset"];

/** Whether the charger ended the session, or reported a fault while it ran. */
export async function chargerEndedSession(
  services: SettlementServices,
  found: SettlementSession,
): Promise<boolean> {
  const { session } = found;
  if (session.stopReason !== null && CHARGER_STOP_REASONS.includes(session.stopReason)) {
    return true;
  }
  return chargerFaultedBetween(services.db, found.charger.id, {
    from: session.startedAt ?? session.createdAt,
    to: session.stoppedAt ?? services.clock.now(),
  });
}

/**
 * Records and sends a full charger-fault refund of the booking's payment.
 * Safe to repeat: one charger-fault refund is recorded per payment.
 */
export async function refundChargerFault(
  services: SettlementServices,
  found: SettlementSession,
): Promise<void> {
  const payment = found.payment;
  if (payment?.status !== "paid") return;
  const refund = await insertRefund(services.db, {
    paymentId: payment.id,
    amountCents: payment.amountCents,
    reason: "charger_fault",
  });
  if (refund === undefined) return;
  services.log.info(
    { bookingId: found.booking.id },
    "the charger delivered nothing; refunded in full",
  );
  if ((await sendRefund(services, payment, refund)) === "pending") {
    await queueResume(services, payment.id);
  }
}
