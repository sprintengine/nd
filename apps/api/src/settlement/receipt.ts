import {
  billingBreakdown,
  billingStart,
  centsPerKwh,
  currencySchema,
  sessionStatusSchema,
  transferHoldReasonSchema,
  transferStatusSchema,
} from "@nd/domain";
import { z } from "zod";

import {
  type BookingDetail,
  findBookingDetail,
  findTransfer,
  type Transfer,
} from "../data/bookings.ts";
import { billedSessionOf, findReview, type Session } from "../data/settlement.ts";
import { HttpProblem } from "../http/problem.ts";
import type { Services } from "../services.ts";
import type { SavedCard } from "../stripe/payments.ts";
import { formatDuration, formatMoney } from "./format.ts";

// The receipt for a finished booking, for its driver or its host. Billing
// is by time: the minutes from session start to stop, rounded up to 5, at
// the hourly price and capped at the quote. kWh are shown, not billed.

const RECEIPT_STATUSES = ["pending", "awaiting_host_confirmation", "needs_review", "paid"] as const;

const receiptLine = z.object({
  kind: z.enum(["time", "cap", "adjustment", "platform_fee"]),
  description: z.string(),
  amountCents: z
    .number()
    .int()
    .describe(
      "Negative for a reduction. A platform fee is taken from the host's payout, not added",
    ),
});

export const receiptSchema = z
  .object({
    bookingId: z.uuid(),
    sessionId: z.uuid(),
    role: z.enum(["driver", "host"]),
    status: z
      .enum(RECEIPT_STATUSES)
      .describe(
        "`pending` until reconciled; `awaiting_host_confirmation` when the session was closed without a stop; `needs_review` while support checks it; `paid` once captured",
      ),
    sessionStatus: sessionStatusSchema,
    currency: currencySchema,
    startedAt: z.iso.datetime(),
    stoppedAt: z.iso.datetime(),
    durationMinutes: z.number().int().describe("From session start to stop, rounded up"),
    billedMinutes: z.number().int().describe("Rounded up to the next 5 minutes"),
    kwh: z.number().nullable().describe("Energy delivered: the meter delta"),
    meter: z.object({
      startKwh: z.number().nullable(),
      stopKwh: z.number().nullable(),
    }),
    pricePerHourCents: z.number().int(),
    quotedAmountCents: z.number().int(),
    lines: z.array(receiptLine),
    capNote: z.string().nullable().describe("Set when the quote capped the charge"),
    totalCents: z
      .number()
      .int()
      .describe("What the driver pays: captured once paid, otherwise the amount due"),
    platformFeeCents: z.number().int(),
    effectiveCentsPerKwh: z
      .number()
      .int()
      .nullable()
      .describe("The total divided by the energy delivered, for comparison; billing is by time"),
    card: z
      .object({ brand: z.string(), last4: z.string() })
      .nullable()
      .describe("The driver's card; driver only"),
    hostPayout: z
      .object({
        amountCents: z.number().int(),
        status: transferStatusSchema,
        holdReason: transferHoldReasonSchema.nullable(),
      })
      .nullable()
      .describe("The host's transfer; host only, once the payment is captured"),
    review: z
      .object({
        rating: z.number().int(),
        comment: z.string().nullable(),
        createdAt: z.iso.datetime(),
      })
      .nullable()
      .describe("The driver's review of this booking"),
    canReview: z.boolean().describe("The driver can still rate this booking"),
  })
  .meta({ id: "Receipt" });

export type Receipt = z.infer<typeof receiptSchema>;

/** Session statuses a receipt can be shown for. */
const RECEIPT_SESSION_STATUSES: readonly Session["status"][] = [
  "stopped",
  "needs_review",
  "needs_host_confirmation",
  "reconciled",
];

/** Whether a session has stopped, so its receipt can be shown. */
export function hasReceipt(session: Session | undefined): session is Session & { stoppedAt: Date } {
  const stoppedAt = session?.stoppedAt ?? null;
  return (
    stoppedAt !== null && session !== undefined && RECEIPT_SESSION_STATUSES.includes(session.status)
  );
}

export interface ReceiptInput {
  readonly detail: BookingDetail;
  readonly session: Session & { stoppedAt: Date };
  readonly role: "driver" | "host";
  readonly card: SavedCard | undefined;
  readonly transfer: Transfer | undefined;
  readonly review: { rating: number; comment: string | null; createdAt: Date } | undefined;
}

function receiptStatus(session: Session, captured: boolean): Receipt["status"] {
  if (session.status === "needs_review") return "needs_review";
  if (session.status === "needs_host_confirmation") return "awaiting_host_confirmation";
  return session.status === "reconciled" || captured ? "paid" : "pending";
}

const toKwh = (wh: number | null) => (wh === null ? null : wh / 1000);

/** Builds the receipt of a stopped session. */
export function buildReceipt(input: ReceiptInput): Receipt {
  const { detail, session, role } = input;
  const { booking, payment } = detail;
  const currency = booking.currency;
  const pricePerHourCents = booking.pricePerHourCents ?? 0;
  const startedAt =
    billingStart({ pluggedInAt: booking.pluggedInAt, startedAt: session.startedAt }) ??
    session.createdAt;
  const stoppedAt = session.stoppedAt < startedAt ? startedAt : session.stoppedAt;
  const breakdown = billingBreakdown(
    startedAt,
    stoppedAt,
    pricePerHourCents,
    booking.quotedAmountCents,
  );
  const captured = payment?.status === "captured";
  const settled = session.status === "reconciled";
  const totalCents = captured || settled ? (payment?.capturedCents ?? 0) : breakdown.amountCents;

  const lines: Receipt["lines"] = [
    {
      kind: "time",
      description: `${formatDuration(breakdown.billedMinutes)} at ${formatMoney(pricePerHourCents, currency)} an hour`,
      amountCents: breakdown.timeCostCents,
    },
  ];
  if (breakdown.capped) {
    lines.push({
      kind: "cap",
      description: `Capped at the quoted ${formatMoney(booking.quotedAmountCents, currency)}`,
      amountCents: breakdown.amountCents - breakdown.timeCostCents,
    });
  }
  if (totalCents !== breakdown.amountCents) {
    lines.push({
      kind: "adjustment",
      description: "Adjusted after review",
      amountCents: totalCents - breakdown.amountCents,
    });
  }
  const platformFeeCents = payment?.platformFeeCents ?? 0;
  if (platformFeeCents > 0) {
    lines.push({
      kind: "platform_fee",
      description: "Platform fee, taken from the host's payout",
      amountCents: platformFeeCents,
    });
  }

  const deliveredWh =
    session.meterStartWh !== null &&
    session.meterStopWh !== null &&
    session.meterStopWh >= session.meterStartWh
      ? session.meterStopWh - session.meterStartWh
      : null;
  const review = input.review;
  return {
    bookingId: booking.id,
    sessionId: session.id,
    role,
    status: receiptStatus(session, captured),
    sessionStatus: session.status,
    currency,
    startedAt: startedAt.toISOString(),
    stoppedAt: stoppedAt.toISOString(),
    durationMinutes: breakdown.actualMinutes,
    billedMinutes: breakdown.billedMinutes,
    kwh: deliveredWh === null ? session.kwh : deliveredWh / 1000,
    meter: { startKwh: toKwh(session.meterStartWh), stopKwh: toKwh(session.meterStopWh) },
    pricePerHourCents,
    quotedAmountCents: booking.quotedAmountCents,
    lines,
    capNote: breakdown.capped
      ? `${formatDuration(breakdown.billedMinutes)} would cost ${formatMoney(breakdown.timeCostCents, currency)}; the charge never goes above the quote of ${formatMoney(booking.quotedAmountCents, currency)}.`
      : null,
    totalCents,
    platformFeeCents,
    effectiveCentsPerKwh:
      deliveredWh === null ? null : (centsPerKwh(totalCents, deliveredWh) ?? null),
    card:
      role === "driver" && input.card !== undefined
        ? { brand: input.card.brand, last4: input.card.last4 }
        : null,
    hostPayout:
      role === "host" && input.transfer !== undefined
        ? {
            amountCents: input.transfer.amountCents,
            status: input.transfer.status,
            holdReason: input.transfer.holdReason,
          }
        : null,
    review:
      review === undefined
        ? null
        : {
            rating: review.rating,
            comment: review.comment,
            createdAt: review.createdAt.toISOString(),
          },
    canReview: role === "driver" && review === undefined && booking.status === "completed",
  };
}

/** A booking's receipt for its driver or host; 404 for anyone else, 409 before the session stops. */
export async function loadReceipt(
  services: Services,
  bookingId: string,
  viewerId: string,
): Promise<Receipt> {
  const detail = await findBookingDetail(services.db, bookingId);
  if (
    detail === undefined ||
    (detail.booking.driverId !== viewerId && detail.host.userId !== viewerId)
  ) {
    throw new HttpProblem(404, "booking-not-found", "No such booking");
  }
  const role = detail.host.userId === viewerId ? "host" : "driver";
  const session = await billedSessionOf(services.db, bookingId);
  if (!hasReceipt(session)) {
    throw new HttpProblem(
      409,
      "receipt-not-ready",
      "There is no receipt yet",
      "A receipt is ready once the charging session has stopped.",
    );
  }
  const { payment, driver } = detail;
  const [card, transfer, review] = await Promise.all([
    role === "driver" && payment?.stripePaymentMethodId && driver.stripeCustomerId
      ? services.payments
          .findCard(driver.stripeCustomerId, payment.stripePaymentMethodId)
          .catch((error: unknown) => {
            services.log.warn({ bookingId, err: error }, "card for a receipt not found");
            return undefined;
          })
      : undefined,
    payment === null ? undefined : findTransfer(services.db, payment.id),
    findReview(services.db, bookingId, detail.booking.driverId),
  ]);
  return buildReceipt({ detail, session, role, card, transfer, review });
}
