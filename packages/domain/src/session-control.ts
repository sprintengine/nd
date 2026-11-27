import { z } from "zod";

import type { Window } from "./pricing.ts";
import { SESSION_STATUSES } from "./status.ts";

// Rules for starting and stopping a charging session from the app: when the
// driver may say they have arrived, when a start may be scheduled, how long a
// remote start may take, and the live figures shown while charging. Pure
// functions; the API applies them. The booking was paid upfront, so none of
// this decides what anyone pays.

const MINUTE_MS = 60_000;

/**
 * By default a driver may say they have arrived (and plug in) from this many
 * minutes before the slot starts; charging then starts at the slot start.
 */
export const ARRIVAL_LEAD_MINUTES = 4 * 60;

/** An arrival position further than this from the charger is noted (never refused). */
export const ARRIVAL_RADIUS_M = 300;

/** A remote start that produces no StartTransaction within this many seconds has failed. */
export const START_TIMEOUT_SECONDS = 120;

/** A session still charging this long after its slot ends is stopped remotely. */
export const WINDOW_END_STOP_GRACE_MINUTES = 5;

/** A latitude and longitude in degrees (WGS 84). */
export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

function assertDate(name: string, value: Date): void {
  if (Number.isNaN(value.getTime())) throw new RangeError(`${name} must be a valid date`);
}

/** When the driver may first say they have arrived for a slot, `leadMinutes` ahead of it. */
export function arrivalOpensAt(slotStart: Date, leadMinutes = ARRIVAL_LEAD_MINUTES): Date {
  assertDate("slotStart", slotStart);
  if (!Number.isSafeInteger(leadMinutes) || leadMinutes < 0) {
    throw new RangeError(`leadMinutes must be a non-negative integer, got ${String(leadMinutes)}`);
  }
  return new Date(slotStart.getTime() - leadMinutes * MINUTE_MS);
}

/** Whether `now` is too early, inside, or past the window in which a driver may arrive. */
export type ArrivalTiming = "early" | "open" | "ended";

/** Arrival is allowed from `leadMinutes` (4 hours by default) before the slot starts until it ends. */
export function arrivalTiming(
  slot: Window,
  now: Date,
  leadMinutes = ARRIVAL_LEAD_MINUTES,
): ArrivalTiming {
  assertDate("now", now);
  if (now.getTime() < arrivalOpensAt(slot.start, leadMinutes).getTime()) return "early";
  if (now.getTime() >= slot.end.getTime()) return "ended";
  return "open";
}

/** Mean Earth radius in metres (IUGG). */
const EARTH_RADIUS_M = 6_371_008.8;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance between two positions, in whole metres (haversine). */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** How far an arrival position is from the charger, and whether that counts as near it. */
export function arrivalCheck(
  charger: LatLng,
  position: LatLng,
): { distanceM: number; nearCharger: boolean } {
  const distanceM = distanceMeters(charger, position);
  return { distanceM, nearCharger: distanceM <= ARRIVAL_RADIUS_M };
}

/** When the window-end stop runs for a slot. */
export function windowEndStopAt(slotEnd: Date): Date {
  assertDate("slotEnd", slotEnd);
  return new Date(slotEnd.getTime() + WINDOW_END_STOP_GRACE_MINUTES * MINUTE_MS);
}

/**
 * Why a requested start time cannot be used, or undefined when it can. A
 * scheduled start must lie inside the slot, before it ends.
 */
export function startAtProblem(slot: Window, startAt: Date): string | undefined {
  if (Number.isNaN(startAt.getTime())) return "startAt must be a valid date";
  if (startAt.getTime() < slot.start.getTime() || startAt.getTime() >= slot.end.getTime()) {
    return "startAt must lie inside the booked slot";
  }
  return undefined;
}

/**
 * Why a start failed. The app shows the matching message from
 * {@link SESSION_FAILURE_MESSAGES} and offers to try again.
 */
export const SESSION_FAILURE_REASONS = [
  "charger_offline",
  "no_response",
  "rejected",
  "start_timeout",
  "gateway_unreachable",
  "stopped_before_start",
  "window_ended",
] as const;
export type SessionFailureReason = (typeof SESSION_FAILURE_REASONS)[number];
export const sessionFailureReasonSchema = z.enum(SESSION_FAILURE_REASONS);

const NO_RESPONSE =
  "The charger didn't respond. Check the cable is plugged in, then try again." as const;

/** What the app tells the driver for each failure. */
export const SESSION_FAILURE_MESSAGES = {
  charger_offline: NO_RESPONSE,
  no_response: NO_RESPONSE,
  start_timeout: NO_RESPONSE,
  rejected: "The charger wouldn't start. Unplug the cable, plug it back in, then try again.",
  gateway_unreachable: "We couldn't reach the charger just now. Try again in a moment.",
  stopped_before_start: "You stopped before charging began.",
  window_ended: "Your booking ended before charging began.",
} as const satisfies Record<SessionFailureReason, string>;

/** Whether a stored stop reason is one of the failure reasons. */
export function isSessionFailureReason(value: string | null): value is SessionFailureReason {
  return (SESSION_FAILURE_REASONS as readonly (string | null)[]).includes(value);
}

/**
 * What the app shows for a booking's charging: a session status, or
 * `not_started` before any start, or `scheduled` while a delayed start waits.
 */
export const LIVE_SESSION_STATUSES = ["not_started", "scheduled", ...SESSION_STATUSES] as const;
export type LiveSessionStatus = (typeof LIVE_SESSION_STATUSES)[number];
export const liveSessionStatusSchema = z.enum(LIVE_SESSION_STATUSES);

/** What the live figures are computed from. */
export interface SessionMetricsInput {
  /** When charging started (StartTransaction); null before it has. */
  readonly startedAt: Date | null;
  /** The stop time of a stopped session, otherwise now. */
  readonly until: Date;
  readonly meterStartWh: number | null;
  /** The latest energy register reading, in Wh. */
  readonly latestEnergyWh: number | null;
  /** kWh recorded when the session stopped; wins over the readings. */
  readonly finalKwh: number | null;
  /** The latest power reading, in W; null when not charging. */
  readonly powerW: number | null;
}

/** The live figures: energy, power and seconds since charging started. */
export interface SessionMetrics {
  readonly kwh: number | null;
  readonly kw: number | null;
  readonly elapsed: number;
}

const round = (value: number, places: number) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Energy (kWh, 3 places), power (kW, 2 places) and seconds since charging
 * started. Shown for information: the booking's price does not depend on them.
 */
export function sessionMetrics(input: SessionMetricsInput): SessionMetrics {
  let kwh: number | null = input.finalKwh;
  if (kwh === null && input.meterStartWh !== null && input.latestEnergyWh !== null) {
    kwh = Math.max(0, input.latestEnergyWh - input.meterStartWh) / 1000;
  }
  const kw = input.powerW === null ? null : round(Math.max(0, input.powerW) / 1000, 2);
  const start = input.startedAt;
  const elapsed =
    start === null || input.until.getTime() <= start.getTime()
      ? 0
      : Math.floor((input.until.getTime() - start.getTime()) / 1000);
  return { kwh: kwh === null ? null : round(kwh, 3), kw, elapsed };
}
