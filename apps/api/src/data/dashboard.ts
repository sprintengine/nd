import type { Executor } from "@nd/db";
import type { BookingStatus, ChargerStatus, Currency } from "@nd/domain";
import { sql } from "drizzle-orm";

// The host's home screen and calendar, in SQL. Periods are calendar months
// and Monday-to-Sunday weeks in the host's time zone (their first charger's),
// and a booking counts in the period its slot starts in.
//
// Earnings are the host's share of captured payments: the transfer amount
// once one exists (sent, pending, held or failed and awaiting a retry), or
// the capture less the platform fee before it does; reversed transfers do not
// count. Sessions are those that finished charging (stopped, reconciled, or
// waiting for review or the host's confirmation); kWh is their total.

/** The host, their time zone and the currency they are paid in. */
export async function dashboardHost(db: Executor, userId: string) {
  const result = await db.execute<{ id: string; timezone: string; currency: Currency }>(sql`
    select h.id,
      coalesce(
        (select c.timezone from chargers c where c.host_id = h.id order by c.created_at, c.id limit 1),
        'Europe/Dublin'
      ) as timezone,
      coalesce(
        (select r.currency from availability_rules r join chargers c on c.id = r.charger_id
          where c.host_id = h.id order by c.created_at, r.created_at limit 1),
        'EUR'
      ) as currency
    from hosts h where h.user_id = ${userId}
  `);
  return result.rows[0];
}

export type DashboardHost = NonNullable<Awaited<ReturnType<typeof dashboardHost>>>;

/** Earnings, sessions and kWh for one period. */
export interface PeriodTotals {
  /** First day of the period, `YYYY-MM-DD` in the host's time zone. */
  readonly start: string;
  readonly earningsCents: number;
  readonly sessions: number;
  readonly kwh: number;
}

interface PeriodRow extends Record<string, unknown> {
  period: "month" | "week";
  idx: number;
  start: string;
  earnings_cents: string | number;
  sessions: string | number;
  kwh: string | number;
}

const roundKwh = (value: string | number) => Math.round(Number(value) * 1000) / 1000;

/** This month's totals and the last 8 weeks', oldest first, the current week last. */
export async function dashboardTotals(
  db: Executor,
  host: DashboardHost,
  now: Date,
): Promise<{ month: PeriodTotals; weeks: PeriodTotals[] }> {
  const tz = host.timezone;
  const at = now.toISOString();
  const result = await db.execute<PeriodRow>(sql`
    with local_now as (select (${at}::timestamptz at time zone ${tz}) as t),
    periods as (
      select 'month' as period, 0 as idx, date_trunc('month', t) as local_from,
        date_trunc('month', t) + interval '1 month' as local_to
      from local_now
      union all
      select 'week', g.i, date_trunc('week', t) - (7 - g.i) * interval '1 week',
        date_trunc('week', t) - (6 - g.i) * interval '1 week'
      from local_now, generate_series(0, 7) as g(i)
    ),
    bounds as (
      select period, idx, to_char(local_from, 'YYYY-MM-DD') as start,
        local_from at time zone ${tz} as from_at, local_to at time zone ${tz} as to_at
      from periods
    ),
    earned as (
      select lower(b.slot) as start_at,
        coalesce(t.amount_cents, p.captured_cents - p.platform_fee_cents) as cents
      from bookings b
      join chargers c on c.id = b.charger_id
      join payments p on p.booking_id = b.id and p.status = 'captured'
      left join transfers t on t.payment_id = p.id
      where c.host_id = ${host.id} and p.currency = ${host.currency}
        and (t.status is null or t.status <> 'reversed')
    ),
    finished as (
      select lower(b.slot) as start_at, coalesce(s.kwh, 0) as kwh
      from sessions s
      join bookings b on b.id = s.booking_id
      join chargers c on c.id = b.charger_id
      where c.host_id = ${host.id}
        and s.status in ('stopped', 'needs_review', 'needs_host_confirmation', 'reconciled')
    )
    select b.period, b.idx, b.start,
      coalesce((select sum(e.cents) from earned e
        where e.start_at >= b.from_at and e.start_at < b.to_at), 0) as earnings_cents,
      (select count(*) from finished f
        where f.start_at >= b.from_at and f.start_at < b.to_at) as sessions,
      coalesce((select sum(f.kwh) from finished f
        where f.start_at >= b.from_at and f.start_at < b.to_at), 0) as kwh
    from bounds b
    order by b.period, b.idx
  `);
  const totals = (row: PeriodRow): PeriodTotals => ({
    start: row.start,
    earningsCents: Number(row.earnings_cents),
    sessions: Number(row.sessions),
    kwh: roundKwh(row.kwh),
  });
  const month = result.rows.find((row) => row.period === "month");
  if (month === undefined) throw new Error("dashboard month totals missing");
  return {
    month: totals(month),
    weeks: result.rows.filter((row) => row.period === "week").map(totals),
  };
}

/** A booking as the host's lists show it. */
export interface HostBookingItem {
  readonly id: string;
  readonly chargerId: string;
  readonly status: BookingStatus;
  readonly start: Date;
  readonly end: Date;
  readonly quotedAmountCents: number;
  readonly currency: Currency;
  readonly driverFirstName: string;
  readonly vehiclePlate: string | null;
}

interface BookingRow extends Record<string, unknown> {
  id: string;
  charger_id: string;
  status: BookingStatus;
  start_at: Date | string;
  end_at: Date | string;
  quoted_amount_cents: number;
  currency: Currency;
  driver_name: string;
  vehicle_plate: string | null;
}

const bookingItem = (row: BookingRow): HostBookingItem => ({
  id: row.id,
  chargerId: row.charger_id,
  status: row.status,
  start: new Date(row.start_at),
  end: new Date(row.end_at),
  quotedAmountCents: row.quoted_amount_cents,
  currency: row.currency,
  driverFirstName: row.driver_name.trim().split(/\s+/)[0] ?? "",
  vehiclePlate: row.vehicle_plate,
});

const bookingColumns = sql`
  b.id, b.charger_id, b.status, lower(b.slot) as start_at, upper(b.slot) as end_at,
  b.quoted_amount_cents, b.currency, u.name as driver_name, b.vehicle_plate
`;

/**
 * Tonight's bookings: those starting from noon today until noon tomorrow in
 * the host's time zone (before noon, "tonight" is the night now ending), with
 * pending requests left to their own list and cancellations left out.
 */
export async function tonightsBookings(
  db: Executor,
  host: DashboardHost,
  now: Date,
): Promise<HostBookingItem[]> {
  const tz = host.timezone;
  const result = await db.execute<BookingRow>(sql`
    with night as (
      select date_trunc('day', (${now.toISOString()}::timestamptz at time zone ${tz}) - interval '12 hours')
        + interval '12 hours' as local_from
    )
    select ${bookingColumns}
    from bookings b
    join chargers c on c.id = b.charger_id
    join users u on u.id = b.driver_id, night
    where c.host_id = ${host.id}
      and b.status in ('confirmed', 'arrived', 'active', 'completed')
      and lower(b.slot) >= night.local_from at time zone ${tz}
      and lower(b.slot) < (night.local_from + interval '1 day') at time zone ${tz}
    order by lower(b.slot), b.id
  `);
  return result.rows.map(bookingItem);
}

/** Requests waiting for the host's answer whose slot has not ended, soonest first. */
export async function pendingRequests(
  db: Executor,
  host: DashboardHost,
  now: Date,
): Promise<HostBookingItem[]> {
  const result = await db.execute<BookingRow>(sql`
    select ${bookingColumns}
    from bookings b
    join chargers c on c.id = b.charger_id
    join users u on u.id = b.driver_id
    where c.host_id = ${host.id} and b.status = 'requested'
      and upper(b.slot) > ${now.toISOString()}::timestamptz
    order by lower(b.slot), b.id
  `);
  return result.rows.map(bookingItem);
}

/** Bookings starting on the local days `from` to `to` (inclusive), without cancellations. */
export async function calendarBookings(
  db: Executor,
  host: DashboardHost,
  days: { from: string; to: string },
): Promise<(HostBookingItem & { day: string })[]> {
  const tz = host.timezone;
  const result = await db.execute<BookingRow & { day: string }>(sql`
    select ${bookingColumns},
      to_char(lower(b.slot) at time zone ${tz}, 'YYYY-MM-DD') as day
    from bookings b
    join chargers c on c.id = b.charger_id
    join users u on u.id = b.driver_id
    where c.host_id = ${host.id} and b.status <> 'cancelled'
      and lower(b.slot) >= ${days.from}::date::timestamp at time zone ${tz}
      and lower(b.slot) < (${days.to}::date + 1)::timestamp at time zone ${tz}
    order by lower(b.slot), b.id
  `);
  return result.rows.map((row) => ({ ...bookingItem(row), day: row.day }));
}

/** Today's date in the host's time zone, `YYYY-MM-DD`. */
export async function localToday(db: Executor, host: DashboardHost, now: Date): Promise<string> {
  const result = await db.execute<{ day: string }>(sql`
    select to_char(${now.toISOString()}::timestamptz at time zone ${host.timezone}, 'YYYY-MM-DD') as day
  `);
  const day = result.rows[0]?.day;
  if (day === undefined) throw new Error("no local date");
  return day;
}

/** A charger card: status, whether it is listed, whether it is charging and its next booking. */
export interface ChargerCard {
  readonly id: string;
  readonly model: string;
  readonly status: ChargerStatus;
  readonly acceptingBookings: boolean;
  readonly lastHeartbeatAt: Date | null;
  readonly charging: boolean;
  /** The charger still refuses to charge without the platform's authorisation. */
  readonly locked: boolean;
  readonly nextBooking: {
    readonly id: string;
    readonly status: BookingStatus;
    readonly start: Date;
    readonly end: Date;
  } | null;
}

interface CardRow extends Record<string, unknown> {
  id: string;
  model: string;
  status: ChargerStatus;
  accepting_bookings: boolean;
  last_heartbeat_at: Date | string | null;
  charging: boolean;
  locked: boolean;
  next_id: string | null;
  next_status: BookingStatus | null;
  next_start: Date | string | null;
  next_end: Date | string | null;
}

/** Every charger of the host, oldest first. */
export async function chargerCards(
  db: Executor,
  host: DashboardHost,
  now: Date,
): Promise<ChargerCard[]> {
  const at = now.toISOString();
  const result = await db.execute<CardRow>(sql`
    select c.id, c.model, c.status, c.accepting_bookings, c.last_heartbeat_at,
      exists (
        select 1 from sessions s join bookings sb on sb.id = s.booking_id
        where sb.charger_id = c.id
          and s.status in ('starting', 'charging', 'suspended_ev', 'suspended_evse')
      ) as charging,
      coalesce(c.ocpp_config ->> 'FreeCharging', '') = 'false' as locked,
      nb.id as next_id, nb.status as next_status,
      lower(nb.slot) as next_start, upper(nb.slot) as next_end
    from chargers c
    left join lateral (
      select b.id, b.status, b.slot from bookings b
      where b.charger_id = c.id and b.status in ('confirmed', 'arrived', 'active')
        and upper(b.slot) > ${at}::timestamptz
      order by lower(b.slot), b.id limit 1
    ) nb on true
    where c.host_id = ${host.id}
    order by c.created_at, c.id
  `);
  return result.rows.map((row) => ({
    id: row.id,
    model: row.model,
    status: row.status,
    acceptingBookings: row.accepting_bookings,
    lastHeartbeatAt: row.last_heartbeat_at === null ? null : new Date(row.last_heartbeat_at),
    charging: row.charging,
    locked: row.locked,
    nextBooking:
      row.next_id === null ||
      row.next_status === null ||
      row.next_start === null ||
      row.next_end === null
        ? null
        : {
            id: row.next_id,
            status: row.next_status,
            start: new Date(row.next_start),
            end: new Date(row.next_end),
          },
  }));
}
