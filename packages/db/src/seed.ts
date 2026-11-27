import {
  type BookingStatus,
  chargeSplit,
  DEFAULT_CARD_FEE_BPS,
  DEFAULT_CARD_FEE_FIXED_CENTS,
} from "@nd/domain";
import { eq } from "drizzle-orm";

import type { Executor } from "./client.ts";
import type { LatLng } from "./schema/columns.ts";
import {
  availabilityRules,
  bookings,
  chargers,
  hosts,
  meterValues,
  ocppMessages,
  payments,
  refunds,
  reviews,
  sessions,
  users,
} from "./schema/tables.ts";

/** Centre of the seed data: Ranelagh, Dublin 6. */
export const SEED_CENTRE: LatLng = { lat: 53.326, lng: -6.256 };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type Insert<T extends { $inferInsert: unknown }> = T["$inferInsert"];

export interface SeedData {
  readonly users: Insert<typeof users>[];
  readonly hosts: Insert<typeof hosts>[];
  readonly chargers: Insert<typeof chargers>[];
  readonly availabilityRules: Insert<typeof availabilityRules>[];
  readonly bookings: Insert<typeof bookings>[];
  readonly sessions: Insert<typeof sessions>[];
  readonly meterValues: Insert<typeof meterValues>[];
  readonly ocppMessages: Insert<typeof ocppMessages>[];
  readonly payments: Insert<typeof payments>[];
  readonly refunds: Insert<typeof refunds>[];
  readonly reviews: Insert<typeof reviews>[];
}

const id = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${n.toString().padStart(12, "0")}`;

const userIds = {
  aoife: "seed-user-aoife",
  cian: "seed-user-cian",
  niamh: "seed-user-niamh",
  sam: "seed-user-sam",
  orla: "seed-user-orla",
} as const;

const hostIds = { aoife: id("00000000", 1), cian: id("00000000", 2), niamh: id("00000000", 3) };

const chargerIds = {
  ranelagh: id("10000000", 1),
  rathmines: id("10000000", 2),
  milltown: id("10000000", 3),
  donnybrook: id("10000000", 4),
};

const bookingIds = {
  requested: id("20000000", 1),
  confirmed: id("20000000", 2),
  arrived: id("20000000", 3),
  active: id("20000000", 4),
  completed: id("20000000", 5),
  cancelled: id("20000000", 6),
  no_show: id("20000000", 7),
} satisfies Record<BookingStatus, string>;

const PRICE_PER_HOUR_CENTS = { ranelagh: 250, rathmines: 220, milltown: 200, donnybrook: 300 };

/**
 * Development data around Ranelagh, Dublin 6: three hosts, four chargers
 * within 2 km, two drivers and a booking in every status, in EUR. Times are
 * relative to `now` so the arrived and active bookings are always current.
 * All names, addresses and identifiers are invented.
 */
export function buildSeedData(now: Date = new Date()): SeedData {
  const base = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  const at = (offsetMs: number) => new Date(base + offsetMs);
  const slot = (startOffsetMs: number, hours: number) => ({
    start: at(startOffsetMs),
    end: at(startOffsetMs + hours * HOUR_MS),
  });
  const quote = (charger: keyof typeof PRICE_PER_HOUR_CENTS, hours: number) =>
    PRICE_PER_HOUR_CENTS[charger] * hours;

  const seedUsers: Insert<typeof users>[] = [
    { id: userIds.aoife, name: "Aoife", email: "aoife@example.com", emailVerified: true },
    { id: userIds.cian, name: "Cian", email: "cian@example.com", emailVerified: true },
    { id: userIds.niamh, name: "Niamh", email: "niamh@example.com", emailVerified: true },
    {
      id: userIds.sam,
      name: "Sam",
      email: "sam@example.com",
      emailVerified: true,
      phone: "+353000000001",
      phoneVerified: true,
    },
    {
      id: userIds.orla,
      name: "Orla",
      email: "orla@example.com",
      emailVerified: true,
      phone: "+353000000002",
      phoneVerified: true,
    },
  ];

  // No host_tax_details rows: the seed cannot encrypt without the API's key.
  // The flag alone lets payouts flow for the complete hosts in development.
  const seedHosts: Insert<typeof hosts>[] = [
    {
      id: hostIds.aoife,
      userId: userIds.aoife,
      stripeAccountId: "acct_seed_aoife",
      payoutStatus: "enabled",
      taxDetailsComplete: true,
      nightRateStart: "23:00",
      nightRateEnd: "08:00",
    },
    {
      id: hostIds.cian,
      userId: userIds.cian,
      stripeAccountId: "acct_seed_cian",
      payoutStatus: "enabled",
      taxDetailsComplete: true,
    },
    {
      id: hostIds.niamh,
      userId: userIds.niamh,
      stripeAccountId: "acct_seed_niamh",
      payoutStatus: "pending",
      taxDetailsComplete: false,
    },
  ];

  const charger = (
    key: keyof typeof chargerIds,
    area: string,
    hostId: string,
    location: LatLng,
    connectorType: "tethered" | "untethered",
    serialSuffix: number,
  ): Insert<typeof chargers> => ({
    id: chargerIds[key],
    hostId,
    model: serialSuffix % 2 === 0 ? "zappi_glo" : "zappi_v2_1",
    serial: `2000000${String(serialSuffix)}`,
    chargeboxId: `seed-${key}`,
    firmware: "5.794",
    maxKw: 7.4,
    connectorType,
    location,
    address: `${String(serialSuffix)} Seed Lane, ${area}, Dublin`,
    status: "online",
    hostIdTag: `HOST${String(serialSuffix).padStart(4, "0")}`,
    lastHeartbeatAt: now,
    acceptingBookings: true,
  });

  const seedChargers = [
    charger("ranelagh", "Ranelagh", hostIds.aoife, { lat: 53.3262, lng: -6.2565 }, "tethered", 1),
    charger(
      "rathmines",
      "Rathmines",
      hostIds.aoife,
      { lat: 53.3225, lng: -6.2655 },
      "untethered",
      2,
    ),
    charger("milltown", "Milltown", hostIds.cian, { lat: 53.3155, lng: -6.252 }, "tethered", 3),
    charger(
      "donnybrook",
      "Donnybrook",
      hostIds.niamh,
      { lat: 53.322, lng: -6.237 },
      "untethered",
      4,
    ),
  ];

  // Every charger takes overnight bookings every day; Rathmines also by day.
  let ruleN = 0;
  const seedRules: Insert<typeof availabilityRules>[] = [];
  for (const [key, chargerId] of Object.entries(chargerIds)) {
    for (let weekday = 1; weekday <= 7; weekday++) {
      seedRules.push({
        id: id("30000000", ++ruleN),
        chargerId,
        weekday,
        startTime: "20:00",
        endTime: "08:00",
        pricePerHourCents: PRICE_PER_HOUR_CENTS[key as keyof typeof PRICE_PER_HOUR_CENTS],
        kwhCap: 40,
        instantBook: key !== "milltown",
      });
      if (key === "rathmines") {
        seedRules.push({
          id: id("30000000", ++ruleN),
          chargerId,
          weekday,
          startTime: "09:00",
          endTime: "17:00",
          pricePerHourCents: 300,
          instantBook: true,
        });
      }
    }
  }

  const tag = (n: number) => `SEED${n.toString().padStart(16, "0")}`;
  const booking = (
    status: BookingStatus,
    chargerKey: keyof typeof chargerIds,
    driverId: string,
    startOffsetMs: number,
    hours: number,
  ): Insert<typeof bookings> => ({
    id: bookingIds[status],
    chargerId: chargerIds[chargerKey],
    driverId,
    slot: slot(startOffsetMs, hours),
    status,
    idTag: tag(Object.keys(bookingIds).indexOf(status) + 1),
    quotedAmountCents: quote(chargerKey, hours),
    currency: "EUR",
    kwhCap: 40,
    vehiclePlate: `26-D-${String(10_000 + Object.keys(bookingIds).indexOf(status))}`,
  });

  const seedBookings: Insert<typeof bookings>[] = [
    booking("requested", "milltown", userIds.orla, 2 * DAY_MS, 8),
    booking("confirmed", "ranelagh", userIds.sam, DAY_MS, 8),
    booking("arrived", "rathmines", userIds.orla, 0, 8),
    booking("active", "milltown", userIds.sam, -2 * HOUR_MS, 8),
    booking("completed", "ranelagh", userIds.orla, -2 * DAY_MS, 8),
    {
      ...booking("cancelled", "donnybrook", userIds.sam, 3 * DAY_MS, 8),
      cancelledAt: at(-HOUR_MS),
      cancelledBy: "driver",
      cancellationReason: "Plans changed",
    },
    booking("no_show", "donnybrook", userIds.orla, -DAY_MS, 8),
  ];

  const activeSessionId = id("40000000", 1);
  const completedSessionId = id("40000000", 2);
  const activeStart = at(-2 * HOUR_MS + 5 * 60 * 1000);
  const completedStart = at(-2 * DAY_MS + 10 * 60 * 1000);
  const completedStop = at(-2 * DAY_MS + 7 * HOUR_MS);

  const seedSessions: Insert<typeof sessions>[] = [
    {
      id: activeSessionId,
      bookingId: bookingIds.active,
      ocppTransactionId: 1001,
      meterStartWh: 1_250_000,
      startedAt: activeStart,
      status: "charging",
    },
    {
      id: completedSessionId,
      bookingId: bookingIds.completed,
      ocppTransactionId: 1000,
      meterStartWh: 1_210_000,
      meterStopWh: 1_242_500,
      kwh: 32.5,
      startedAt: completedStart,
      stoppedAt: completedStop,
      stopReason: "Remote",
      status: "reconciled",
    },
  ];

  const seedMeterValues: Insert<typeof meterValues>[] = [0, 1, 2].map((minute) => ({
    sessionId: activeSessionId,
    ts: new Date(activeStart.getTime() + (minute + 1) * 60 * 1000),
    energyWh: 1_250_000 + (minute + 1) * 120,
    powerW: 7_200,
    currentA: 31.3,
  }));

  const seedOcppMessages: Insert<typeof ocppMessages>[] = [
    {
      chargerId: chargerIds.milltown,
      direction: "in",
      messageType: "call",
      messageId: "seed-start-1001",
      action: "StartTransaction",
      payload: { connectorId: 1, idTag: tag(4), meterStart: 1_250_000, timestamp: activeStart },
      ts: activeStart,
    },
    {
      chargerId: chargerIds.milltown,
      direction: "out",
      messageType: "call_result",
      messageId: "seed-start-1001",
      action: null,
      payload: { transactionId: 1001, idTagInfo: { status: "Accepted" } },
      ts: activeStart,
    },
  ];

  // Every booking is paid upfront with a destination charge; the card fee is passed on to the host.
  const fees = {
    platformFeeBps: 0,
    cardFeeBps: DEFAULT_CARD_FEE_BPS,
    cardFeeFixedCents: DEFAULT_CARD_FEE_FIXED_CENTS,
  };
  const charge = (
    n: number,
    status: BookingStatus,
    charger: keyof typeof PRICE_PER_HOUR_CENTS,
    paymentStatus: "authorised" | "paid",
  ): Insert<typeof payments> => {
    const split = chargeSplit(quote(charger, 8), fees);
    return {
      id: id("50000000", n),
      bookingId: bookingIds[status],
      stripePaymentIntentId: `pi_seed_${status}`,
      stripeChargeId: paymentStatus === "paid" ? `ch_seed_${status}` : null,
      amountCents: split.amountCents,
      platformFeeCents: split.platformFeeCents,
      cardFeeCents: split.cardFeeCents,
      status: paymentStatus,
      captureMethod: paymentStatus === "authorised" ? "manual" : "automatic",
    };
  };
  const seedPayments: Insert<typeof payments>[] = [
    // A request holds the card until the host answers.
    charge(1, "requested", "milltown", "authorised"),
    charge(2, "confirmed", "ranelagh", "paid"),
    charge(3, "arrived", "rathmines", "paid"),
    charge(4, "active", "milltown", "paid"),
    charge(5, "completed", "ranelagh", "paid"),
    charge(6, "cancelled", "donnybrook", "paid"),
    // A no-show is not refunded.
    charge(7, "no_show", "donnybrook", "paid"),
  ];

  // Sam cancelled three days ahead, well before the cutoff: refunded in full.
  const seedRefunds: Insert<typeof refunds>[] = [
    {
      id: id("60000000", 1),
      paymentId: id("50000000", 6),
      amountCents: quote("donnybrook", 8),
      currency: "EUR",
      reason: "driver_cancelled",
      status: "succeeded",
      stripeRefundId: "re_seed_cancelled",
    },
  ];

  const seedReviews: Insert<typeof reviews>[] = [
    {
      id: id("70000000", 1),
      bookingId: bookingIds.completed,
      reviewerId: userIds.orla,
      revieweeId: userIds.aoife,
      rating: 5,
      comment: "Easy to find and the cable reached fine.",
    },
    {
      id: id("70000000", 2),
      bookingId: bookingIds.completed,
      reviewerId: userIds.aoife,
      revieweeId: userIds.orla,
      rating: 5,
    },
  ];

  return {
    users: seedUsers,
    hosts: seedHosts,
    chargers: seedChargers,
    availabilityRules: seedRules,
    bookings: seedBookings,
    sessions: seedSessions,
    meterValues: seedMeterValues,
    ocppMessages: seedOcppMessages,
    payments: seedPayments,
    refunds: seedRefunds,
    reviews: seedReviews,
  };
}

export interface SeedResult {
  /** False when the seed data was already present and nothing was written. */
  readonly inserted: boolean;
}

/**
 * Inserts the development seed data in one transaction. Running it again is a
 * no-op: it stops if the first seed user already exists.
 */
export async function seed(db: Executor, now: Date = new Date()): Promise<SeedResult> {
  const data = buildSeedData(now);
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userIds.aoife))
      .limit(1);
    if (existing.length > 0) {
      return { inserted: false };
    }
    await tx.insert(users).values(data.users);
    await tx.insert(hosts).values(data.hosts);
    await tx.insert(chargers).values(data.chargers);
    await tx.insert(availabilityRules).values(data.availabilityRules);
    await tx.insert(bookings).values(data.bookings);
    await tx.insert(sessions).values(data.sessions);
    await tx.insert(meterValues).values(data.meterValues);
    await tx.insert(ocppMessages).values(data.ocppMessages);
    await tx.insert(payments).values(data.payments);
    await tx.insert(refunds).values(data.refunds);
    await tx.insert(reviews).values(data.reviews);
    return { inserted: true };
  });
}
