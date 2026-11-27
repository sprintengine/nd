import {
  bookingStatusSchema,
  centsPerKwh,
  currencySchema,
  hostEarnings,
  isOpenSession,
  refundReasonSchema,
  refundStatusSchema,
  sessionStatusSchema,
  slotMinutes,
  TERMINAL_BOOKING_STATUSES,
} from "@nd/domain";
import { z } from "zod";

import { type BookingDetail, findBookingDetail } from "../data/bookings.ts";
import { type Refund, refundsOf } from "../data/payments.ts";
import { billedSessionOf, findReview, meterSamples, type Session } from "../data/settlement.ts";
import { HttpProblem } from "../http/problem.ts";
import type { Services } from "../services.ts";
import type { SavedCard } from "../stripe/payments.ts";

// The receipt for a paid booking, for its driver or its host: the price paid
// upfront for the booked hours, any refunds, and the session as evidence of
// what the charger did (start and stop, kWh, meter readings and power
// samples). Nothing on it depends on the energy or the minutes used. The host
// also sees the card fee passed on to them and what they keep.

/** Most meter samples a receipt lists. */
export const RECEIPT_SAMPLE_LIMIT = 500;

const isoDateTime = z.iso.datetime();

export const receiptSchema = z
  .object({
    bookingId: z.uuid(),
    role: z.enum(["driver", "host"]),
    bookingStatus: bookingStatusSchema,
    currency: currencySchema,
    start: isoDateTime.describe("The booked slot, which is the charging window"),
    end: isoDateTime,
    bookedMinutes: z.number().int(),
    pricePerHourCents: z.number().int(),
    paidCents: z.number().int().describe("The booking's price, paid upfront"),
    refunds: z.array(
      z.object({
        amountCents: z.number().int(),
        reason: refundReasonSchema,
        status: refundStatusSchema,
        createdAt: isoDateTime,
      }),
    ),
    refundedCents: z.number().int().describe("Refunded, or being refunded"),
    totalCents: z.number().int().describe("What the driver paid, less refunds"),
    session: z
      .object({
        sessionId: z.uuid(),
        status: sessionStatusSchema,
        startedAt: isoDateTime.nullable(),
        stoppedAt: isoDateTime.nullable(),
        stopReason: z.string().nullable(),
        kwh: z.number().nullable().describe("Energy delivered: the meter delta"),
        meter: z.object({ startKwh: z.number().nullable(), stopKwh: z.number().nullable() }),
        samples: z
          .array(
            z.object({
              at: isoDateTime,
              registerKwh: z.number().nullable(),
              kw: z.number().nullable(),
            }),
          )
          .describe(
            "Meter readings and power while charging, oldest first: evidence the charger worked",
          ),
      })
      .nullable()
      .describe("The charging session; null when none started"),
    effectiveCentsPerKwh: z
      .number()
      .int()
      .nullable()
      .describe("What was paid divided by the energy delivered, for comparison only"),
    card: z
      .object({ brand: z.string(), last4: z.string() })
      .nullable()
      .describe("The driver's card; driver only"),
    hostEarnings: z
      .object({
        grossCents: z.number().int(),
        cardFeeCents: z.number().int().describe("The card fee, passed on to the host"),
        platformFeeCents: z.number().int(),
        netCents: z.number().int().describe("What the host receives"),
      })
      .nullable()
      .describe("Host only"),
    review: z
      .object({
        rating: z.number().int(),
        comment: z.string().nullable(),
        createdAt: isoDateTime,
      })
      .nullable()
      .describe("The driver's review of this booking"),
    canReview: z.boolean().describe("The driver can still rate this booking"),
  })
  .meta({ id: "Receipt" });

export type Receipt = z.infer<typeof receiptSchema>;

type Sample = Awaited<ReturnType<typeof meterSamples>>[number];

export interface ReceiptInput {
  readonly detail: BookingDetail & { payment: NonNullable<BookingDetail["payment"]> };
  readonly role: "driver" | "host";
  readonly session: Session | undefined;
  readonly samples: readonly Sample[];
  readonly refunds: readonly Refund[];
  readonly card: SavedCard | undefined;
  readonly review: { rating: number; comment: string | null; createdAt: Date } | undefined;
}

const toKwh = (wh: number | null) => (wh === null ? null : wh / 1000);

/** Builds a paid booking's receipt. */
export function buildReceipt(input: ReceiptInput): Receipt {
  const { detail, role, session, review } = input;
  const { booking, payment } = detail;
  const refundedCents = input.refunds
    .filter((refund) => refund.status !== "failed")
    .reduce((total, refund) => total + refund.amountCents, 0);
  const totalCents = payment.amountCents - refundedCents;
  const start = session?.meterStartWh ?? null;
  const stop = session?.meterStopWh ?? null;
  const deliveredWh = start !== null && stop !== null && stop >= start ? stop - start : null;
  return {
    bookingId: booking.id,
    role,
    bookingStatus: booking.status,
    currency: booking.currency,
    start: booking.slot.start.toISOString(),
    end: booking.slot.end.toISOString(),
    bookedMinutes: slotMinutes(booking.slot),
    pricePerHourCents: booking.pricePerHourCents ?? 0,
    paidCents: payment.amountCents,
    refunds: input.refunds.map((refund) => ({
      amountCents: refund.amountCents,
      reason: refund.reason,
      status: refund.status,
      createdAt: refund.createdAt.toISOString(),
    })),
    refundedCents,
    totalCents,
    session:
      session === undefined
        ? null
        : {
            sessionId: session.id,
            status: session.status,
            startedAt: session.startedAt?.toISOString() ?? null,
            stoppedAt: session.stoppedAt?.toISOString() ?? null,
            stopReason: session.stopReason,
            kwh: deliveredWh === null ? session.kwh : deliveredWh / 1000,
            meter: { startKwh: toKwh(session.meterStartWh), stopKwh: toKwh(session.meterStopWh) },
            samples: input.samples.map((sample) => ({
              at: sample.ts.toISOString(),
              registerKwh: toKwh(sample.energyWh),
              kw: sample.powerW === null ? null : sample.powerW / 1000,
            })),
          },
    effectiveCentsPerKwh:
      deliveredWh === null ? null : (centsPerKwh(totalCents, deliveredWh) ?? null),
    card:
      role === "driver" && input.card !== undefined
        ? { brand: input.card.brand, last4: input.card.last4 }
        : null,
    hostEarnings: role === "host" ? hostEarnings(payment, refundedCents) : null,
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

/**
 * A booking's receipt for its driver or host; 404 for anyone else, 409 until
 * it was paid and has finished (or its session has stopped).
 */
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
  const { payment, driver, booking } = detail;
  const session = await billedSessionOf(services.db, bookingId);
  const finished =
    (TERMINAL_BOOKING_STATUSES as readonly string[]).includes(booking.status) ||
    (session !== undefined && !isOpenSession(session.status));
  if (payment?.status !== "paid" || !finished) {
    throw new HttpProblem(
      409,
      "receipt-not-ready",
      "There is no receipt yet",
      "A receipt is ready once a paid booking has finished or its session has stopped.",
    );
  }
  const [card, refunds, samples, review] = await Promise.all([
    role === "driver" && payment.stripePaymentMethodId && driver.stripeCustomerId
      ? services.payments
          .findCard(driver.stripeCustomerId, payment.stripePaymentMethodId)
          .catch((error: unknown) => {
            services.log.warn({ bookingId, err: error }, "card for a receipt not found");
            return undefined;
          })
      : undefined,
    refundsOf(services.db, payment.id),
    session === undefined ? [] : meterSamples(services.db, session.id, RECEIPT_SAMPLE_LIMIT),
    findReview(services.db, bookingId, booking.driverId),
  ]);
  return buildReceipt({
    detail: { ...detail, payment },
    role,
    session,
    samples,
    refunds,
    card,
    review,
  });
}
