import { randomInt } from "node:crypto";

import {
  type BookingStatus,
  canTransitionSession,
  type ChargerStatus,
  type SessionStatus,
} from "@nd/domain";
import type { AuthorizationStatus, ChargePointErrorCode, ChargePointStatus } from "@nd/ocpp-core";

// Pure decisions the message handlers make. The store supplies the facts.

/**
 * idTag a Zappi reports for a session started on the charger itself (plug and
 * charge, free charging) rather than by a booking.
 */
export const PLUG_AND_CHARGE_ID_TAG = "PlugandChargeID";

/** What the store knows about an idTag presented on one charger, at one moment. */
export interface TagFacts {
  /** The booking with this idTag on this charger, if any. */
  readonly booking:
    { readonly id: string; readonly status: BookingStatus; readonly slotOpen: boolean } | undefined;
  /** The charger's own free-vend tag. */
  readonly hostIdTag: string | null;
  /** A paid booking (confirmed, arrived or active) holds the charger right now. */
  readonly paidWindow: boolean;
}

export type TagDecision =
  | { readonly kind: "booking"; readonly bookingId: string }
  | { readonly kind: "host"; readonly blocked: boolean }
  | { readonly kind: "invalid" };

const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * A booking's idTag is valid while the booking is arrived or active and its
 * slot is open. The host's own tag (or the plug-and-charge tag) starts a host
 * session, blocked while a paid booking holds the charger. Anything else is
 * invalid.
 */
export function decideIdTag(idTag: string, facts: TagFacts): TagDecision {
  const { booking } = facts;
  if (
    booking !== undefined &&
    booking.slotOpen &&
    (booking.status === "arrived" || booking.status === "active")
  ) {
    return { kind: "booking", bookingId: booking.id };
  }
  const isHostTag =
    (facts.hostIdTag !== null && sameTag(idTag, facts.hostIdTag)) ||
    sameTag(idTag, PLUG_AND_CHARGE_ID_TAG);
  if (isHostTag && booking === undefined) {
    return { kind: "host", blocked: facts.paidWindow };
  }
  return { kind: "invalid" };
}

/** The idTagInfo status for a decision. */
export function authorizationStatus(decision: TagDecision): AuthorizationStatus {
  switch (decision.kind) {
    case "booking":
      return "Accepted";
    case "host":
      return decision.blocked ? "Blocked" : "Accepted";
    case "invalid":
      return "Invalid";
  }
}

/** Whether a StatusNotification reports a fault. */
export function isFault(errorCode: ChargePointErrorCode, status: ChargePointStatus): boolean {
  return errorCode !== "NoError" || status === "Faulted";
}

/**
 * The charger status after a StatusNotification: `faulted` on a fault, and
 * back to `online` from `faulted` or `offline` once it reports no error. An
 * onboarding charger stays onboarding until it boots.
 */
export function chargerStatusAfterNotification(
  current: ChargerStatus,
  errorCode: ChargePointErrorCode,
  status: ChargePointStatus,
): ChargerStatus {
  if (current === "onboarding") {
    return current;
  }
  if (isFault(errorCode, status)) {
    return "faulted";
  }
  return current === "faulted" || current === "offline" ? "online" : current;
}

const CONNECTOR_SESSION_STATUS: Partial<Record<ChargePointStatus, SessionStatus>> = {
  Charging: "charging",
  SuspendedEV: "suspended_ev",
  SuspendedEVSE: "suspended_evse",
};

/**
 * The session status a connector status maps to, when the session may make
 * that move. A session still `starting` waits for StartTransaction.
 */
export function sessionStatusAfterNotification(
  current: SessionStatus,
  status: ChargePointStatus,
): SessionStatus | undefined {
  const next = CONNECTOR_SESSION_STATUS[status];
  if (next === undefined || next === current || current === "starting") {
    return undefined;
  }
  return canTransitionSession(current, next) ? next : undefined;
}

/** kWh between two energy register readings in Wh, or null when the meter went backwards. */
export function deliveredKwh(meterStartWh: number, meterStopWh: number): number | null {
  return meterStopWh >= meterStartWh ? (meterStopWh - meterStartWh) / 1000 : null;
}

/** Largest OCPP transactionId: a 32-bit signed integer. */
export const MAX_TRANSACTION_ID = 2_147_483_647;

/** A random positive OCPP transactionId. */
export function randomTransactionId(): number {
  return randomInt(1, MAX_TRANSACTION_ID);
}
