import { randomBytes } from "node:crypto";

import {
  bookings,
  chargers,
  type Executor,
  hosts,
  payments,
  sessions,
  transfers,
  users,
} from "@nd/db";
import type { BookingStatus, SessionStatus, TransferStatus } from "@nd/domain";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { insertBooking, insertListedCharger } from "../../test/fixtures.ts";
import { type Harness, startHarness } from "../../test/harness.ts";
import { APP_ORIGIN } from "../../test/http.ts";

// The host's dashboard against Postgres: totals equal a direct SQL sum over
// seeded bookings, sessions, payments and transfers; the weekly series,
// charger cards, tonight's and pending lists and the calendar; and switching
// a listing off.

/** A Thursday in March, before Ireland moves to summer time on the 28th. */
const NOW = new Date("2027-03-18T12:00:00Z");
const clock = { now: () => NOW };
const HOUR = 3_600_000;

let h: Harness;
let host: string;
let hostUserId: string;
let chargerA: string;
let chargerB: string;
let otherCharger: string;
let driverId: string;
const ids: Record<string, string> = {};

interface Seed {
  readonly key: string;
  readonly chargerId: string;
  readonly start: string;
  readonly hours?: number;
  readonly status: BookingStatus;
  readonly payment?: { captured: number; fee?: number; status?: "captured" | "authorised" };
  readonly transfer?: { amount: number; status: TransferStatus };
  readonly session?: { status: SessionStatus; kwh: number | null };
}

async function seed(db: Executor, row: Seed): Promise<void> {
  const start = new Date(row.start);
  const end = new Date(start.getTime() + (row.hours ?? 9) * HOUR);
  const [booking] = await db
    .insert(bookings)
    .values({
      chargerId: row.chargerId,
      driverId,
      slot: { start, end },
      status: row.status,
      idTag:
        row.status === "requested" || row.status === "cancelled"
          ? null
          : `T${randomBytes(9).toString("hex").toUpperCase()}`,
      quotedAmountCents: 3000,
      pricePerHourCents: 250,
      vehiclePlate: "231-D-1234",
      ...(row.status === "cancelled"
        ? { cancelledAt: start, cancelledBy: "driver" as const, cancellationFeeCents: 0 }
        : {}),
    })
    .returning({ id: bookings.id });
  if (booking === undefined) throw new Error("booking not inserted");
  ids[row.key] = booking.id;
  if (row.payment !== undefined) {
    const status = row.payment.status ?? "captured";
    const [payment] = await db
      .insert(payments)
      .values({
        bookingId: booking.id,
        status,
        authorisedCents: 3000,
        capturedCents: status === "captured" ? row.payment.captured : 0,
        platformFeeCents: row.payment.fee ?? 0,
      })
      .returning({ id: payments.id });
    if (payment !== undefined && row.transfer !== undefined) {
      await db.insert(transfers).values({
        paymentId: payment.id,
        amountCents: row.transfer.amount,
        status: row.transfer.status,
        holdReason: row.transfer.status === "held" ? "session_needs_review" : null,
      });
    }
  }
  if (row.session !== undefined) {
    await db.insert(sessions).values({
      bookingId: booking.id,
      status: row.session.status,
      kwh: row.session.kwh,
      startedAt: start,
      ...(row.session.kwh === null ? {} : { stoppedAt: end }),
    });
  }
}

const get = (url: string, cookie = host) =>
  h.app.inject({ method: "GET", url, headers: { cookie } });

beforeAll(async () => {
  h = await startHarness({ clock });
  const db = h.database.db;
  host = await h.user("niamh.host@example.com", "+353861110101");
  const me = await get("/me");
  hostUserId = me.json<{ id: string }>().id;
  const driver = await h.user("cian.driver@example.com", "+353861110102");
  driverId = (await get("/me", driver)).json<{ id: string }>().id;
  await db.update(users).set({ name: "Cian Byrne" }).where(eq(users.id, driverId));

  const [hostRow] = await db
    .insert(hosts)
    .values({ userId: hostUserId, payoutStatus: "enabled" })
    .returning({ id: hosts.id });
  if (hostRow === undefined) throw new Error("host not inserted");
  const charger = async (serial: string, extra: Partial<typeof chargers.$inferInsert> = {}) => {
    const [row] = await db
      .insert(chargers)
      .values({
        hostId: hostRow.id,
        model: "zappi_v2_1",
        serial,
        chargeboxId: `dash-${serial}`,
        firmware: "5.794",
        maxKw: 7.4,
        connectorType: "tethered",
        location: { lat: 53.326, lng: -6.256 },
        address: "1 Test Lane, Dublin",
        status: "online",
        acceptingBookings: true,
        lastHeartbeatAt: NOW,
        ...extra,
      })
      .returning({ id: chargers.id });
    if (row === undefined) throw new Error("charger not inserted");
    return row.id;
  };
  chargerA = await charger("20000001", { ocppConfig: { FreeCharging: "false" } });
  chargerB = await charger("20000002");
  otherCharger = (await insertListedCharger(db, { lat: 53.33, lng: -6.25 })).chargerId;

  const rows: Seed[] = [
    // March
    {
      key: "b1",
      chargerId: chargerA,
      start: "2027-03-02T22:00:00Z",
      status: "completed",
      payment: { captured: 2000, fee: 100 },
      transfer: { amount: 1900, status: "sent" },
      session: { status: "reconciled", kwh: 10.5 },
    },
    {
      key: "b2",
      chargerId: chargerA,
      start: "2027-03-16T22:00:00Z",
      status: "completed",
      payment: { captured: 1500 },
      session: { status: "stopped", kwh: 4.25 },
    },
    {
      key: "b3",
      chargerId: chargerB,
      start: "2027-03-10T22:00:00Z",
      status: "completed",
      payment: { captured: 1200 },
      transfer: { amount: 1200, status: "held" },
      session: { status: "needs_review", kwh: 3 },
    },
    {
      key: "b5",
      chargerId: chargerA,
      start: "2027-03-05T22:00:00Z",
      status: "completed",
      payment: { captured: 800 },
      transfer: { amount: 800, status: "reversed" },
      session: { status: "reconciled", kwh: 2 },
    },
    {
      key: "b6",
      chargerId: chargerA,
      start: "2027-03-08T22:00:00Z",
      status: "cancelled",
      payment: { captured: 500 },
      transfer: { amount: 500, status: "pending" },
    },
    {
      key: "b7",
      chargerId: chargerB,
      start: "2027-03-12T22:00:00Z",
      status: "completed",
      payment: { captured: 0, status: "authorised" },
      session: { status: "failed", kwh: null },
    },
    // February, and 00:30 on 1 April in Dublin (still 31 March in UTC)
    {
      key: "b4",
      chargerId: chargerA,
      start: "2027-02-26T22:00:00Z",
      status: "completed",
      payment: { captured: 3000 },
      transfer: { amount: 3000, status: "sent" },
      session: { status: "reconciled", kwh: 20 },
    },
    {
      key: "b9",
      chargerId: chargerA,
      start: "2027-03-31T23:30:00Z",
      hours: 2,
      status: "completed",
      payment: { captured: 700 },
      session: { status: "reconciled", kwh: 1 },
    },
    // Another host's
    {
      key: "b8",
      chargerId: otherCharger,
      start: "2027-03-03T22:00:00Z",
      status: "completed",
      payment: { captured: 2999 },
      session: { status: "reconciled", kwh: 9 },
    },
    // Tonight, in progress, pending and cancelled
    {
      key: "b10",
      chargerId: chargerA,
      start: "2027-03-18T22:00:00Z",
      status: "confirmed",
      payment: { captured: 0, status: "authorised" },
    },
    {
      key: "b13",
      chargerId: chargerB,
      start: "2027-03-18T11:00:00Z",
      hours: 8,
      status: "active",
      session: { status: "charging", kwh: null },
    },
    { key: "b11", chargerId: chargerA, start: "2027-03-20T22:00:00Z", status: "requested" },
    { key: "b12", chargerId: chargerA, start: "2027-03-21T22:00:00Z", status: "cancelled" },
  ];
  for (const row of rows) await seed(db, row);
});

afterAll(async () => {
  await h.close();
});

interface Period {
  start: string;
  earningsCents: number;
  sessions: number;
  kwh: number;
}

/** The totals straight from the tables, for bookings of the host starting in [from, to). */
async function directSums(from: string, to: string) {
  const result = await h.database.db.execute<{ cents: string; sessions: string; kwh: string }>(sql`
    select
      (select coalesce(sum(coalesce(t.amount_cents, p.captured_cents - p.platform_fee_cents)), 0)
        from payments p
        join bookings b on b.id = p.booking_id
        left join transfers t on t.payment_id = p.id
        where b.charger_id in (${chargerA}, ${chargerB}) and p.status = 'captured'
          and (t.status is null or t.status <> 'reversed')
          and lower(b.slot) >= ${from}::timestamptz and lower(b.slot) < ${to}::timestamptz) as cents,
      (select count(*) from sessions s join bookings b on b.id = s.booking_id
        where b.charger_id in (${chargerA}, ${chargerB}) and s.stopped_at is not null
          and s.status <> 'failed'
          and lower(b.slot) >= ${from}::timestamptz and lower(b.slot) < ${to}::timestamptz) as sessions,
      (select coalesce(sum(s.kwh), 0) from sessions s join bookings b on b.id = s.booking_id
        where b.charger_id in (${chargerA}, ${chargerB})
          and lower(b.slot) >= ${from}::timestamptz and lower(b.slot) < ${to}::timestamptz) as kwh
  `);
  const row = result.rows[0];
  return {
    earningsCents: Number(row?.cents),
    sessions: Number(row?.sessions),
    kwh: Number(row?.kwh),
  };
}

describe("GET /hosts/dashboard", () => {
  it("adds up this month exactly as a direct SQL sum does", async () => {
    const response = await get("/hosts/dashboard");
    expect(response.statusCode).toBe(200);
    const body = response.json<{ timezone: string; month: Period & { currency: string } }>();
    expect(body.timezone).toBe("Europe/Dublin");
    // Dublin is on UTC until 28 March, then UTC+1: April starts at 23:00 UTC on the 31st.
    const direct = await directSums("2027-03-01T00:00:00Z", "2027-03-31T23:00:00Z");
    expect(body.month).toEqual({ start: "2027-03-01", currency: "EUR", ...direct });
    // And by hand: 1900 sent + 1500 not yet transferred + 1200 held + 500 fee; the reversed one is out.
    expect(direct).toEqual({ earningsCents: 5100, sessions: 4, kwh: 19.75 });
  });

  it("has 8 Monday-to-Sunday weeks, each matching its own sum", async () => {
    const weeks = (await get("/hosts/dashboard")).json<{ weeks: Period[] }>().weeks;
    expect(weeks.map((week) => week.start)).toEqual([
      "2027-01-25",
      "2027-02-01",
      "2027-02-08",
      "2027-02-15",
      "2027-02-22",
      "2027-03-01",
      "2027-03-08",
      "2027-03-15",
    ]);
    for (const week of weeks) {
      const from = new Date(`${week.start}T00:00:00Z`);
      const to = new Date(from.getTime() + 7 * 24 * HOUR);
      expect({ ...week, start: undefined }).toEqual({
        start: undefined,
        ...(await directSums(from.toISOString(), to.toISOString())),
      });
    }
    expect(weeks.at(-4)).toMatchObject({ earningsCents: 3000, sessions: 1, kwh: 20 });
    expect(weeks.at(-1)).toMatchObject({ earningsCents: 1500, sessions: 1, kwh: 4.25 });
  });

  it("shows each charger's pill, listing and next booking, tonight's bookings and requests", async () => {
    const body = (await get("/hosts/dashboard")).json<{
      chargers: {
        id: string;
        pill: string;
        acceptingBookings: boolean;
        nextBooking: { id: string } | null;
      }[];
      tonight: { id: string; driverFirstName: string }[];
      pendingRequests: { id: string; status: string }[];
    }>();
    expect(body.chargers).toEqual([
      expect.objectContaining({
        id: chargerA,
        pill: "locked",
        acceptingBookings: true,
        nextBooking: expect.objectContaining({ id: ids.b10, status: "confirmed" }) as unknown,
      }),
      expect.objectContaining({
        id: chargerB,
        pill: "charging",
        nextBooking: expect.objectContaining({ id: ids.b13, status: "active" }) as unknown,
      }),
    ]);
    expect(body.tonight.map((booking) => booking.id)).toEqual([ids.b10]);
    // First name and plate only: the host never sees the driver's surname.
    expect(body.tonight[0]).toMatchObject({ driverFirstName: "Cian", vehiclePlate: "231-D-1234" });
    expect(body.pendingRequests.map((booking) => booking.id)).toEqual([ids.b11]);
  });

  it("is 403 for a user who is not a host", async () => {
    const stranger = await h.user("sam.nobody@example.com");
    expect((await get("/hosts/dashboard", stranger)).statusCode).toBe(403);
  });
});

describe("GET /hosts/calendar", () => {
  it("lists every day with the bookings starting on it, without cancellations", async () => {
    const response = await get("/hosts/calendar?from=2027-03-15&to=2027-03-21");
    expect(response.statusCode).toBe(200);
    const days = response.json<{ days: { date: string; bookings: { id: string }[] }[] }>().days;
    expect(days.map((day) => [day.date, day.bookings.map((booking) => booking.id)])).toEqual([
      ["2027-03-15", []],
      ["2027-03-16", [ids.b2]],
      ["2027-03-17", []],
      ["2027-03-18", [ids.b13, ids.b10]],
      ["2027-03-19", []],
      ["2027-03-20", [ids.b11]],
      ["2027-03-21", []],
    ]);
  });

  it("files a booking under its local day", async () => {
    const days = (await get("/hosts/calendar?from=2027-03-31&to=2027-04-01")).json<{
      days: { date: string; bookings: { id: string }[] }[];
    }>().days;
    expect(days).toEqual([
      { date: "2027-03-31", bookings: [] },
      { date: "2027-04-01", bookings: [expect.objectContaining({ id: ids.b9 })] },
    ]);
  });
});

describe("PATCH /hosts/chargers/:id {acceptingBookings: false}", () => {
  it("hides the charger from the very next search but keeps its confirmed bookings", async () => {
    const window = {
      lat: "53.326",
      lng: "-6.256",
      from: "2027-03-22T22:00:00.000Z",
      to: "2027-03-23T06:00:00.000Z",
    };
    // A listed charger with availability rules, so it shows in search.
    const { chargerId, hostUserId: listedHost } = await insertListedCharger(h.database.db, {
      lat: 53.3262,
      lng: -6.2561,
    });
    await insertBooking(h.database.db, chargerId, driverId, {
      start: new Date("2027-03-24T22:00:00Z"),
      end: new Date("2027-03-25T06:00:00Z"),
    });
    // Sign the fixture's host in, with a verified phone, to switch the listing off.
    await h.database.db.execute(
      sql`update users set email = 'aoife.listed@example.com' where id = ${listedHost}`,
    );
    const listedCookie = await h.user("aoife.listed@example.com", "+353861110103");
    const search = async () =>
      (await h.app.inject({ method: "GET", url: "/chargers", query: window }))
        .json<{ results: { id: string }[] }>()
        .results.map((result) => result.id);
    expect(await search()).toContain(chargerId);

    const patched = await h.app.inject({
      method: "PATCH",
      url: `/hosts/chargers/${chargerId}`,
      headers: { cookie: listedCookie, origin: APP_ORIGIN },
      payload: { acceptingBookings: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ acceptingBookings: false });
    expect(await search()).not.toContain(chargerId);

    const kept = await h.database.db
      .select({ status: bookings.status })
      .from(bookings)
      .where(eq(bookings.chargerId, chargerId));
    expect(kept).toEqual([{ status: "confirmed" }]);
  });
});
