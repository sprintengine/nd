import type { Currency, TransferHoldReason } from "@nd/domain";

import type { EmailMessage } from "../senders/senders.ts";
import { formatDateTime, formatKwh, formatMoney, formatPeriod } from "./format.ts";

// Plain-text emails about settling sessions and paying hosts.

/** A session closed from its last meter value because no StopTransaction came. */
export interface ClosedSessionNotice {
  readonly bookingId: string;
  readonly driver: { readonly name: string; readonly email: string };
  readonly host: { readonly name: string; readonly email: string };
  readonly startedAt: Date;
  readonly stoppedAt: Date;
  readonly kwh: number;
  readonly timezone: string;
  readonly confirmationDueAt: Date;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** Tells the driver the session was closed from the last reading and when they will be charged. */
export function closedSessionDriverEmail(notice: ClosedSessionNotice): EmailMessage {
  const period = formatPeriod(notice.startedAt, notice.stoppedAt, notice.timezone);
  return {
    to: notice.driver.email,
    subject: "Your charging session was closed from its last meter reading",
    text: [
      `Hi ${firstName(notice.driver.name)},`,
      "",
      "The charger stopped reporting before your session ended, so we closed it from the last meter reading we received:",
      "",
      `  ${period}, ${formatKwh(notice.kwh)}`,
      "",
      `We have asked the host to confirm it. You will be charged for this time only after they confirm, or on ${formatDateTime(notice.confirmationDueAt, notice.timezone)} if they do not reply. Your receipt will show the details.`,
      "",
      `Booking reference: ${notice.bookingId}`,
    ].join("\n"),
  };
}

/** Asks the host to confirm (or dispute) a session closed from the last reading. */
export function closedSessionHostEmail(notice: ClosedSessionNotice): EmailMessage {
  const period = formatPeriod(notice.startedAt, notice.stoppedAt, notice.timezone);
  return {
    to: notice.host.email,
    subject: "Please confirm a charging session",
    text: [
      `Hi ${firstName(notice.host.name)},`,
      "",
      "Your charger stopped reporting before a driver's session ended, so we closed it from the last meter reading we received:",
      "",
      `  ${period}, ${formatKwh(notice.kwh)}`,
      "",
      `Please confirm the session in the app, or dispute it if something is wrong. If we do not hear from you by ${formatDateTime(notice.confirmationDueAt, notice.timezone)}, the driver will be charged as recorded and your payout will follow.`,
      "",
      `Booking reference: ${notice.bookingId}`,
    ].join("\n"),
  };
}

/** Why a host's transfer is held, in words, with what releases it. */
export const HOLD_REASON_TEXT: Record<TransferHoldReason, string> = {
  session_needs_review: "the session is being reviewed",
  dispute_open: "a dispute is open",
  tax_details_incomplete: "your tax details are incomplete; add them in the app to release it",
  payouts_not_enabled: "payouts are not enabled on your Stripe account yet",
};

/** One session in a host's weekly summary. */
export interface PayoutSummaryLine {
  readonly bookingId: string;
  readonly start: Date;
  readonly end: Date;
  readonly timezone: string;
  readonly kwh: number | null;
  /** What the driver paid; null while the session is not billed yet. */
  readonly capturedCents: number | null;
  /** The host's share; null before a transfer exists. */
  readonly payoutCents: number | null;
  readonly state: "paid_out" | "held" | "pending" | "needs_review" | "awaiting_confirmation";
  readonly holdReason: TransferHoldReason | null;
}

export interface PayoutSummary {
  readonly host: { readonly name: string; readonly email: string };
  readonly currency: Currency;
  readonly from: Date;
  readonly to: Date;
  /** Time zone the week's dates are written in. */
  readonly timezone: string;
  /** Sessions that stopped in the week. */
  readonly sessions: readonly PayoutSummaryLine[];
  /** Every transfer still held, from this week or before. */
  readonly held: readonly PayoutSummaryLine[];
}

const STATE_TEXT: Record<PayoutSummaryLine["state"], string> = {
  paid_out: "paid out",
  held: "held",
  pending: "payout pending",
  needs_review: "being reviewed",
  awaiting_confirmation: "waiting for your confirmation",
};

function sessionLine(line: PayoutSummaryLine, currency: Currency): string {
  const parts = [formatPeriod(line.start, line.end, line.timezone)];
  if (line.kwh !== null) parts.push(formatKwh(line.kwh));
  if (line.payoutCents !== null) parts.push(formatMoney(line.payoutCents, currency));
  else if (line.capturedCents !== null) parts.push(formatMoney(line.capturedCents, currency));
  parts.push(STATE_TEXT[line.state]);
  return `- ${parts.join(" · ")}`;
}

const sum = (lines: readonly PayoutSummaryLine[], state: PayoutSummaryLine["state"]) =>
  lines
    .filter((line) => line.state === state)
    .reduce((total, line) => total + (line.payoutCents ?? 0), 0);

/** The weekly email to a host: the week's sessions and amounts, and held transfers with why. */
export function payoutSummaryEmail(summary: PayoutSummary): EmailMessage {
  const { currency } = summary;
  const days = `${formatDay(summary.from, summary.timezone)} to ${formatDay(summary.to, summary.timezone)}`;
  const text = [`Hi ${firstName(summary.host.name)},`, "", `Your payouts for ${days}.`, ""];
  if (summary.sessions.length === 0) {
    text.push("No sessions ended this week.");
  } else {
    text.push(`Sessions (${String(summary.sessions.length)}):`);
    for (const line of summary.sessions) text.push(sessionLine(line, currency));
    text.push("", `Paid out: ${formatMoney(sum(summary.sessions, "paid_out"), currency)}`);
  }
  if (summary.held.length > 0) {
    text.push(
      "",
      `Held: ${formatMoney(sum(summary.held, "held"), currency)}`,
      "",
      "Held transfers and why:",
    );
    for (const line of summary.held) {
      const amount = formatMoney(line.payoutCents ?? 0, currency);
      const reason = line.holdReason === null ? "held" : HOLD_REASON_TEXT[line.holdReason];
      text.push(`- ${amount} for ${formatDateTime(line.start, line.timezone)}: ${reason}`);
    }
  }
  text.push(
    "",
    "Amounts are your share, after any platform fee. Payouts reach your bank on Stripe's schedule after we send them.",
  );
  return { to: summary.host.email, subject: `Your payouts for ${days}`, text: text.join("\n") };
}

function formatDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IE", {
    timeZone,
    day: "numeric",
    month: "short",
  }).format(at);
}
