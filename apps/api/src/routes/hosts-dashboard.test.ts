import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NOW, SESSION_COOKIE, signInAs, startUnitApp } from "../../test/unit-app.ts";
import * as data from "../data/dashboard.ts";
import { chargerPill, daysBetween } from "./hosts-dashboard.ts";

vi.mock("../data/dashboard.ts");

const HOST = {
  id: "66666666-6666-4666-8666-666666666666",
  timezone: "Europe/Dublin",
  currency: "EUR" as const,
};
const CHARGER_ID = "22222222-2222-4222-8222-222222222222";
const BOOKING_ID = "11111111-1111-4111-8111-111111111111";
const item = {
  id: BOOKING_ID,
  chargerId: CHARGER_ID,
  status: "requested" as const,
  start: new Date("2027-01-12T22:00:00Z"),
  end: new Date("2027-01-13T07:00:00Z"),
  quotedAmountCents: 2250,
  currency: "EUR" as const,
  driverFirstName: "Niamh",
  vehiclePlate: "231-D-1234",
};
const period = (start: string) => ({
  start,
  grossCents: 0,
  cardFeeCents: 0,
  earningsCents: 0,
  sessions: 0,
  kwh: 0,
});

let app: FastifyInstance;
beforeEach(() => {
  ({ app } = startUnitApp());
  signInAs(app);
  vi.mocked(data.dashboardHost).mockResolvedValue(HOST);
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

const get = (url: string) => app.inject({ method: "GET", url, headers: SESSION_COOKIE });

describe("GET /hosts/dashboard", () => {
  it("puts the totals, cards and lists together", async () => {
    vi.mocked(data.dashboardTotals).mockResolvedValue({
      month: {
        start: "2027-01-01",
        grossCents: 4400,
        cardFeeCents: 200,
        earningsCents: 4200,
        sessions: 3,
        kwh: 21.5,
      },
      weeks: Array.from({ length: 8 }, (_v, index) => period(`2026-11-${String(16 + index)}`)),
    });
    vi.mocked(data.chargerCards).mockResolvedValue([
      {
        id: CHARGER_ID,
        model: "zappi_v2_1",
        status: "online",
        acceptingBookings: true,
        lastHeartbeatAt: NOW,
        charging: false,
        locked: true,
        nextBooking: { id: BOOKING_ID, status: "confirmed", start: item.start, end: item.end },
      },
    ]);
    vi.mocked(data.tonightsBookings).mockResolvedValue([{ ...item, status: "confirmed" }]);
    vi.mocked(data.pendingRequests).mockResolvedValue([item]);
    const response = await get("/hosts/dashboard");
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      month: object;
      weeks: unknown[];
      chargers: object[];
      pendingRequests: object[];
      tonight: { status: string }[];
    }>();
    expect(body.month).toEqual({
      start: "2027-01-01",
      grossCents: 4400,
      cardFeeCents: 200,
      earningsCents: 4200,
      sessions: 3,
      kwh: 21.5,
      currency: "EUR",
    });
    expect(body.weeks).toHaveLength(8);
    expect(body.chargers[0]).toMatchObject({ pill: "locked", nextBooking: { id: BOOKING_ID } });
    expect(body.pendingRequests[0]).toMatchObject({
      driverFirstName: "Niamh",
      start: "2027-01-12T22:00:00.000Z",
    });
    expect(body.tonight[0]?.status).toBe("confirmed");
  });

  it("is 403 for someone who is not a host", async () => {
    vi.mocked(data.dashboardHost).mockResolvedValue(undefined);
    const response = await get("/hosts/dashboard");
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "host-required" });
  });
});

describe("GET /hosts/calendar", () => {
  it("lists 30 days from today by default, every day present", async () => {
    vi.mocked(data.localToday).mockResolvedValue("2027-01-11");
    vi.mocked(data.calendarBookings).mockResolvedValue([{ ...item, day: "2027-01-12" }]);
    const response = await get("/hosts/calendar");
    expect(response.statusCode).toBe(200);
    const body = response.json<{ days: { bookings: unknown[] }[] }>();
    expect(body).toMatchObject({ timezone: "Europe/Dublin", from: "2027-01-11", to: "2027-02-09" });
    expect(body.days).toHaveLength(30);
    expect(body.days[1]).toMatchObject({ date: "2027-01-12", bookings: [{ id: BOOKING_ID }] });
    expect(body.days[0]?.bookings).toEqual([]);
    expect(data.calendarBookings).toHaveBeenCalledWith(expect.anything(), HOST, {
      from: "2027-01-11",
      to: "2027-02-09",
    });
  });

  it("refuses more than 31 days or a backwards range", async () => {
    vi.mocked(data.calendarBookings).mockResolvedValue([]);
    expect((await get("/hosts/calendar?from=2027-01-01&to=2027-01-31")).statusCode).toBe(200);
    for (const query of ["from=2027-01-01&to=2027-02-01", "from=2027-01-02&to=2027-01-01"]) {
      const response = await get(`/hosts/calendar?${query}`);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "invalid-range" });
    }
    expect((await get("/hosts/calendar?from=tomorrow")).statusCode).toBe(400);
  });
});

describe("helpers", () => {
  it("chargerPill puts faults first, then charging and locked", () => {
    expect(chargerPill({ status: "faulted", charging: true, locked: true })).toBe("faulted");
    expect(chargerPill({ status: "online", charging: true, locked: true })).toBe("charging");
    expect(chargerPill({ status: "online", charging: false, locked: true })).toBe("locked");
    expect(chargerPill({ status: "online", charging: false, locked: false })).toBe("online");
  });

  it("daysBetween counts inclusive days across a month end and stops past the limit", () => {
    expect(daysBetween("2027-01-30", "2027-02-02")).toEqual([
      "2027-01-30",
      "2027-01-31",
      "2027-02-01",
      "2027-02-02",
    ]);
    expect(daysBetween("2027-01-01", "2030-01-01", 5)).toHaveLength(6);
  });
});
