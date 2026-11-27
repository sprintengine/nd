import {
  bookings,
  chargers,
  disputes,
  type Executor,
  formatTimeRange,
  hosts,
  payments,
  sessions,
  stripeWebhookEvents,
  transfers,
  users,
} from "@nd/db";
import type {
  BookingStatus,
  CancelledBy,
  Currency,
  PaymentStatus,
  TransferHoldReason,
  TransferStatus,
} from "@nd/domain";
import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";

import { isSlotTaken } from "../bookings/rules.ts";

// Reads and writes behind bookings, payments and their jobs. Integration
// tests cover them against Postgres; unit tests mock this module.

/** A charger with what booking it needs from its host. */
export async function findBookableCharger(db: Executor, chargerId: string) {
  const [row] = await db
    .select({
      id: chargers.id,
      status: chargers.status,
      acceptingBookings: chargers.acceptingBookings,
      timezone: chargers.timezone,
      hostId: hosts.id,
      hostUserId: hosts.userId,
      maxSessionsPerDay: hosts.maxSessionsPerDay,
    })
    .from(chargers)
    .innerJoin(hosts, eq(hosts.id, chargers.hostId))
    .where(eq(chargers.id, chargerId))
    .limit(1);
  return row;
}

export type BookableCharger = NonNullable<Awaited<ReturnType<typeof findBookableCharger>>>;

/** Booking statuses that use one of the host's sessions for the day. */
const DAY_COUNTED_STATUSES = [
  "requested",
  "confirmed",
  "arrived",
  "active",
  "completed",
] as const satisfies readonly BookingStatus[];

/** How many of the host's bookings, on any charger, start inside `day`. */
export async function hostBookingsStarting(
  db: Executor,
  hostId: string,
  day: { start: Date; end: Date },
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bookings)
    .innerJoin(chargers, eq(chargers.id, bookings.chargerId))
    .where(
      and(
        eq(chargers.hostId, hostId),
        inArray(bookings.status, [...DAY_COUNTED_STATUSES]),
        sql`lower(${bookings.slot}) >= ${day.start.toISOString()}::timestamptz`,
        sql`lower(${bookings.slot}) < ${day.end.toISOString()}::timestamptz`,
      ),
    );
  return row?.count ?? 0;
}

/** A user's name, email and Stripe customer. */
export async function findCustomer(db: Executor, userId: string) {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      stripeCustomerId: users.stripeCustomerId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row;
}

/**
 * Stores the user's Stripe customer unless one is already stored, and returns
 * the one that is (so two racing requests end up with the same customer).
 */
export async function saveCustomerId(
  db: Executor,
  userId: string,
  customerId: string,
): Promise<string> {
  await db
    .update(users)
    .set({ stripeCustomerId: customerId })
    .where(and(eq(users.id, userId), sql`${users.stripeCustomerId} is null`));
  const [row] = await db
    .select({ stripeCustomerId: users.stripeCustomerId })
    .from(users)
    .where(eq(users.id, userId));
  return row?.stripeCustomerId ?? customerId;
}

/** Whether a confirmed, arrived or active booking holds any of `window` on the charger. */
export async function slotTaken(
  db: Executor,
  chargerId: string,
  window: { start: Date; end: Date },
): Promise<boolean> {
  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.chargerId, chargerId),
        inArray(bookings.status, ["confirmed", "arrived", "active"]),
        sql`${bookings.slot} && ${formatTimeRange(window)}::tstzrange`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export interface NewBooking {
  readonly chargerId: string;
  readonly driverId: string;
  readonly slot: { start: Date; end: Date };
  readonly status: "requested" | "confirmed";
  readonly idTag: string | null;
  readonly quotedAmountCents: number;
  readonly pricePerHourCents: number;
  readonly currency: Currency;
  readonly kwhCap: number | null;
  readonly vehiclePlate: string;
  readonly paymentMethodId: string;
}

/**
 * Inserts a booking and its payment (pending authorisation) in one
 * transaction. The charger row is locked, so a request is checked against
 * slot-holding bookings without a race; a confirmed booking also relies on
 * the exclusion constraint. Resolves to undefined when the slot is taken.
 */
export function insertBookingWithPayment(
  db: Executor,
  booking: NewBooking,
): Promise<{ bookingId: string; paymentId: string } | undefined> {
  return db
    .transaction(async (tx) => {
      await tx
        .select({ id: chargers.id })
        .from(chargers)
        .where(eq(chargers.id, booking.chargerId))
        .for("update");
      const [clash] = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(
          and(
            eq(bookings.chargerId, booking.chargerId),
            inArray(bookings.status, ["confirmed", "arrived", "active"]),
            sql`${bookings.slot} && ${formatTimeRange(booking.slot)}::tstzrange`,
          ),
        )
        .limit(1);
      if (clash !== undefined) return undefined;
      const { paymentMethodId, ...values } = booking;
      const [inserted] = await tx.insert(bookings).values(values).returning({ id: bookings.id });
      if (inserted === undefined) throw new Error("booking not inserted");
      const [payment] = await tx
        .insert(payments)
        .values({
          bookingId: inserted.id,
          currency: booking.currency,
          stripePaymentMethodId: paymentMethodId,
        })
        .returning({ id: payments.id });
      if (payment === undefined) throw new Error("payment not inserted");
      return { bookingId: inserted.id, paymentId: payment.id };
    })
    .catch((error: unknown) => {
      if (isSlotTaken(error)) return undefined;
      throw error;
    });
}

/** Bookings with their charger, host, driver and payment, matching `where`. */
function bookingDetailQuery(db: Executor, where: SQL | undefined) {
  return db
    .select({
      booking: bookings,
      charger: {
        id: chargers.id,
        address: chargers.address,
        location: chargers.location,
        timezone: chargers.timezone,
      },
      host: {
        id: hosts.id,
        userId: hosts.userId,
        cancellationCutoffMinutes: hosts.cancellationCutoffMinutes,
      },
      driver: {
        name: users.name,
        stripeCustomerId: users.stripeCustomerId,
      },
      payment: payments,
    })
    .from(bookings)
    .innerJoin(chargers, eq(chargers.id, bookings.chargerId))
    .innerJoin(hosts, eq(hosts.id, chargers.hostId))
    .innerJoin(users, eq(users.id, bookings.driverId))
    .leftJoin(payments, eq(payments.bookingId, bookings.id))
    .where(where);
}

/** A booking with its charger, host, driver and payment: everything its rules need. */
export async function findBookingDetail(db: Executor, bookingId: string) {
  const [row] = await bookingDetailQuery(db, eq(bookings.id, bookingId)).limit(1);
  return row;
}

export type BookingDetail = NonNullable<Awaited<ReturnType<typeof findBookingDetail>>>;

/** Which bookings a list shows. */
export interface BookingListFilter {
  readonly statuses?: readonly BookingStatus[];
  /** Only bookings overlapping this window. */
  readonly window?: { start: Date; end: Date };
  readonly limit: number;
}

function listConditions(filter: BookingListFilter) {
  return [
    filter.statuses === undefined || filter.statuses.length === 0
      ? undefined
      : inArray(bookings.status, [...filter.statuses]),
    filter.window === undefined
      ? undefined
      : sql`${bookings.slot} && ${formatTimeRange(filter.window)}::tstzrange`,
  ];
}

/** Ids of a driver's bookings, latest slot first. */
export async function driverBookingIds(
  db: Executor,
  driverId: string,
  filter: BookingListFilter,
): Promise<string[]> {
  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.driverId, driverId), ...listConditions(filter)))
    .orderBy(desc(sql`lower(${bookings.slot})`))
    .limit(filter.limit);
  return rows.map((row) => row.id);
}

/** Ids of bookings at a host's chargers, latest slot first. */
export async function hostBookingIds(
  db: Executor,
  hostUserId: string,
  filter: BookingListFilter,
): Promise<string[]> {
  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .innerJoin(chargers, eq(chargers.id, bookings.chargerId))
    .innerJoin(hosts, eq(hosts.id, chargers.hostId))
    .where(and(eq(hosts.userId, hostUserId), ...listConditions(filter)))
    .orderBy(desc(sql`lower(${bookings.slot})`))
    .limit(filter.limit);
  return rows.map((row) => row.id);
}

/** Several bookings' details, in the order of `ids`. */
export async function findBookingDetails(
  db: Executor,
  ids: readonly string[],
): Promise<BookingDetail[]> {
  if (ids.length === 0) return [];
  const rows = await bookingDetailQuery(db, inArray(bookings.id, [...ids]));
  const byId = new Map(rows.map((row) => [row.booking.id, row]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

export interface BookingChange {
  readonly status?: BookingStatus;
  readonly idTag?: string;
  readonly cancelledAt?: Date;
  readonly cancelledBy?: CancelledBy;
  readonly cancellationReason?: string;
  readonly cancellationFeeCents?: number;
}

/**
 * Changes a booking only while it is still in one of `from`, so two racing
 * changes cannot both apply. Resolves to whether it changed. Throws the
 * exclusion violation when a confirmation would overlap another booking.
 */
export async function updateBookingFrom(
  db: Executor,
  bookingId: string,
  from: readonly BookingStatus[],
  change: BookingChange,
): Promise<boolean> {
  const rows = await db
    .update(bookings)
    .set(change)
    .where(and(eq(bookings.id, bookingId), inArray(bookings.status, [...from])))
    .returning({ id: bookings.id });
  return rows.length > 0;
}

export interface PaymentChange {
  readonly status?: PaymentStatus;
  readonly stripePaymentIntentId?: string | null;
  readonly stripeChargeId?: string | null;
  readonly authoriseAt?: Date | null;
  readonly authorisedCents?: number;
  readonly capturedCents?: number;
  readonly platformFeeCents?: number;
  readonly failureReason?: string | null;
}

/** Changes a payment only while it is in one of `from`. Resolves to whether it changed. */
export async function updatePaymentFrom(
  db: Executor,
  paymentId: string,
  from: readonly PaymentStatus[],
  change: PaymentChange,
): Promise<boolean> {
  const rows = await db
    .update(payments)
    .set(change)
    .where(and(eq(payments.id, paymentId), inArray(payments.status, [...from])))
    .returning({ id: payments.id });
  return rows.length > 0;
}

export type Payment = typeof payments.$inferSelect;

export async function findPayment(db: Executor, paymentId: string): Promise<Payment | undefined> {
  const [row] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  return row;
}

export async function findPaymentByIntent(
  db: Executor,
  paymentIntentId: string,
): Promise<Payment | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(eq(payments.stripePaymentIntentId, paymentIntentId))
    .limit(1);
  return row;
}

/** What deciding on a transfer to the host needs. */
export async function findTransferContext(db: Executor, paymentId: string) {
  const [row] = await db
    .select({
      bookingId: bookings.id,
      stripeAccountId: hosts.stripeAccountId,
      payoutStatus: hosts.payoutStatus,
      taxDetailsComplete: hosts.taxDetailsComplete,
    })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .innerJoin(chargers, eq(chargers.id, bookings.chargerId))
    .innerJoin(hosts, eq(hosts.id, chargers.hostId))
    .where(eq(payments.id, paymentId))
    .limit(1);
  if (row === undefined) return undefined;
  const [latest] = await db
    .select({ status: sessions.status })
    .from(sessions)
    .where(eq(sessions.bookingId, row.bookingId))
    .orderBy(desc(sessions.createdAt))
    .limit(1);
  const [open] = await db
    .select({ id: disputes.id })
    .from(disputes)
    .where(
      and(
        eq(disputes.bookingId, row.bookingId),
        inArray(disputes.status, ["open", "under_review"]),
      ),
    )
    .limit(1);
  return {
    ...row,
    sessionStatus: latest?.status ?? null,
    disputeOpen: open !== undefined,
  };
}

export type TransferContext = NonNullable<Awaited<ReturnType<typeof findTransferContext>>>;

export type Transfer = typeof transfers.$inferSelect;

export async function findTransfer(db: Executor, paymentId: string): Promise<Transfer | undefined> {
  const [row] = await db
    .select()
    .from(transfers)
    .where(eq(transfers.paymentId, paymentId))
    .limit(1);
  return row;
}

/** Creates or updates the payment's one transfer row. */
export async function saveTransfer(
  db: Executor,
  paymentId: string,
  values: {
    readonly amountCents: number;
    readonly currency: Currency;
    readonly status: TransferStatus;
    readonly holdReason: TransferHoldReason | null;
    readonly stripeTransferId?: string;
    readonly sentAt?: Date;
  },
): Promise<Transfer> {
  const [row] = await db
    .insert(transfers)
    .values({ paymentId, ...values })
    .onConflictDoUpdate({ target: transfers.paymentId, set: values })
    .returning();
  if (row === undefined) throw new Error("transfer not saved");
  return row;
}

/**
 * Records a webhook event id. Resolves to false when it was recorded before,
 * meaning the event has already been processed.
 */
export async function recordWebhookEvent(
  db: Executor,
  event: { id: string; type: string },
): Promise<boolean> {
  const rows = await db
    .insert(stripeWebhookEvents)
    .values({ id: event.id, type: event.type })
    .onConflictDoNothing()
    .returning({ id: stripeWebhookEvents.id });
  return rows.length > 0;
}

/** Mirrors a connected account's state onto its host. Resolves to whether a host matched. */
export async function setPayoutStatusByAccount(
  db: Executor,
  stripeAccountId: string,
  payoutStatus: "pending" | "enabled" | "restricted",
): Promise<boolean> {
  const rows = await db
    .update(hosts)
    .set({ payoutStatus })
    .where(eq(hosts.stripeAccountId, stripeAccountId))
    .returning({ id: hosts.id });
  return rows.length > 0;
}
