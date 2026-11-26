import { hostPayoutSummary, hostsWithPayoutActivity, type PayoutLine } from "../data/settlement.ts";
import type { Services } from "../services.ts";
import { payoutSummaryEmail, type PayoutSummaryLine } from "./emails.ts";
import { hostPayoutSummaryJob } from "./jobs.ts";

// The weekly payout summary: every Friday each host with a session that
// week, or a transfer still held, gets one email listing the sessions, what
// was paid out and what is held and why.

const WEEK_MS = 7 * 24 * 3_600_000;

/** Queues one summary per host with activity in the week up to now. Resolves to how many. */
export async function queueWeeklyPayoutSummaries(services: Services): Promise<number> {
  const to = services.clock.now();
  const from = new Date(to.getTime() - WEEK_MS);
  const hostIds = await hostsWithPayoutActivity(services.db, { start: from, end: to });
  for (const hostId of hostIds) {
    await services.jobs.send(
      hostPayoutSummaryJob,
      { hostId, from: from.toISOString(), to: to.toISOString() },
      { singletonKey: `${hostId}:${to.toISOString().slice(0, 10)}` },
    );
  }
  return hostIds.length;
}

function summaryLine(line: PayoutLine): PayoutSummaryLine {
  const state: PayoutSummaryLine["state"] =
    line.transferStatus === "sent"
      ? "paid_out"
      : line.transferStatus === "held"
        ? "held"
        : line.sessionStatus === "needs_review"
          ? "needs_review"
          : line.sessionStatus === "needs_host_confirmation"
            ? "awaiting_confirmation"
            : "pending";
  return {
    bookingId: line.bookingId,
    start: line.startedAt ?? line.slot.start,
    end: line.stoppedAt ?? line.slot.end,
    timezone: line.timezone,
    kwh: line.kwh,
    capturedCents:
      line.capturedCents !== null && line.capturedCents > 0 ? line.capturedCents : null,
    payoutCents: line.transferCents,
    state,
    holdReason: line.holdReason,
  };
}

/** Emails one host their summary for `[from, to)`. Resolves to whether one was sent. */
export async function sendHostPayoutSummary(
  services: Services,
  input: { hostId: string; from: Date; to: Date },
): Promise<boolean> {
  const window = { start: input.from, end: input.to };
  const found = await hostPayoutSummary(services.db, input.hostId, window);
  if (found === undefined || found.lines.length === 0) return false;
  const inWeek = (line: PayoutLine) =>
    line.stoppedAt !== null && line.stoppedAt >= input.from && line.stoppedAt < input.to;
  const first = found.lines[0];
  await services.email.send(
    payoutSummaryEmail({
      host: found.host,
      currency: first?.currency ?? "EUR",
      timezone: first?.timezone ?? "Europe/Dublin",
      from: input.from,
      to: input.to,
      sessions: found.lines.filter(inWeek).map(summaryLine),
      held: found.lines.filter((line) => line.transferStatus === "held").map(summaryLine),
    }),
  );
  return true;
}
