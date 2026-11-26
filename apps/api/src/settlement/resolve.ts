import { findSettlementSession, resolveOpenDisputes } from "../data/settlement.ts";
import { HttpProblem } from "../http/problem.ts";
import { PaymentStateError } from "../payments/settlement.ts";
import { captureSession, completeSettlement } from "./reconcile.ts";
import type { SettlementServices } from "./services.ts";

// Support clears a session that needs review by deciding what the driver
// pays. Admins are a fixed list of user ids (ADMIN_USER_IDS) for now.

/**
 * Captures `amountCents` for a session in `needs_review` or waiting for the
 * host, closes the booking's open disputes with `note`, marks the session
 * reconciled and sends (or holds) the host's transfer. 0 releases the whole
 * authorisation. Never more than was authorised.
 */
export async function resolveSession(
  services: SettlementServices,
  sessionId: string,
  amountCents: number,
  note: string,
): Promise<void> {
  const found = await findSettlementSession(services.db, sessionId);
  if (found === undefined) throw new HttpProblem(404, "session-not-found", "No such session");
  const status = found.session.status;
  if (status !== "needs_review" && status !== "needs_host_confirmation") {
    throw new HttpProblem(409, "session-not-in-review", "This session is not waiting for review");
  }
  try {
    await captureSession(services, found, amountCents);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new HttpProblem(
        422,
        "amount-above-authorisation",
        "That is more than the driver's card was authorised for",
        error.message,
      );
    }
    if (error instanceof PaymentStateError) {
      throw new HttpProblem(
        409,
        "payment-not-capturable",
        "The payment cannot be captured",
        error.message,
      );
    }
    throw error;
  }
  await resolveOpenDisputes(services.db, found.booking.id, note, services.clock.now());
  await completeSettlement(services, found);
  services.log.info(
    { sessionId, bookingId: found.booking.id, amountCents },
    "session resolved by support",
  );
}
