import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_ID, bookingDetail } from "../../test/booking-detail.ts";
import { sessionContext } from "../../test/session-context.ts";
import { SESSION_COOKIE, signInAs, startUnitApp, USER_ID } from "../../test/unit-app.ts";
import * as bookings from "../data/bookings.ts";
import { HttpProblem } from "../http/problem.ts";
import * as control from "../sessions/control.ts";

vi.mock("../data/bookings.ts");
vi.mock("../sessions/control.ts");

let app: FastifyInstance;

const send = (method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: SESSION_COOKIE,
    ...(payload === undefined ? {} : { payload }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  ({ app } = startUnitApp());
  signInAs(app);
  vi.mocked(control.contextFor).mockResolvedValue(
    sessionContext({ booking: { driverId: USER_ID } }),
  );
  vi.mocked(bookings.findBookingDetail).mockResolvedValue(
    bookingDetail(USER_ID, { booking: { status: "arrived" } }),
  );
});

describe("session routes", () => {
  it("checks in with an optional position", async () => {
    const arrivedAt = new Date("2027-01-12T21:50:00Z");
    vi.mocked(control.arrive).mockResolvedValue({ arrivedAt, distanceM: 40, nearCharger: true });
    const response = await send("POST", `/bookings/${BOOKING_ID}/arrive`, { lat: 53.3, lng: -6.2 });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      booking: { id: BOOKING_ID, status: "arrived" },
      arrival: { arrivedAt: arrivedAt.toISOString(), distanceM: 40, nearCharger: true },
    });
    expect(control.arrive).toHaveBeenCalledWith(expect.anything(), USER_ID, BOOKING_ID, {
      lat: 53.3,
      lng: -6.2,
    });

    vi.mocked(control.arrive).mockResolvedValue({
      arrivedAt: null,
      distanceM: null,
      nearCharger: null,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/bookings/${BOOKING_ID}/arrive`,
          headers: SESSION_COOKIE,
        })
      ).statusCode,
    ).toBe(200);
    expect(vi.mocked(control.arrive).mock.calls.at(-1)?.[3]).toBeUndefined();
    expect((await send("POST", `/bookings/${BOOKING_ID}/arrive`, { lng: 1 })).statusCode).toBe(400);
    expect(
      (await send("POST", `/bookings/${BOOKING_ID}/arrive`, { lat: 91, lng: 1 })).statusCode,
    ).toBe(400);
  });

  it("is 404 when the booking vanished after checking in", async () => {
    vi.mocked(control.arrive).mockResolvedValue({
      arrivedAt: null,
      distanceM: null,
      nearCharger: null,
    });
    vi.mocked(bookings.findBookingDetail).mockResolvedValue(undefined);
    expect((await send("POST", `/bookings/${BOOKING_ID}/arrive`, {})).statusCode).toBe(404);
  });

  it("gives session control the configured durations", async () => {
    await app.close();
    ({ app } = startUnitApp({
      sessionStartTimeoutSeconds: 7,
      staleSessionGraceMinutes: 2,
      minBookingMinutes: 3,
    }));
    signInAs(app);
    expect((await send("POST", `/bookings/${BOOKING_ID}/start`, {})).statusCode).toBe(200);
    expect(vi.mocked(control.startCharging).mock.calls.at(-1)?.[0]).toMatchObject({
      sessionTimings: { startTimeoutSeconds: 7, resetRetryDelaySeconds: 20 },
      timings: { staleSessionGraceMinutes: 2, minBookingMinutes: 3 },
    });
  });

  it("starts, now or later, and stops, answering with the session", async () => {
    const started = await send("POST", `/bookings/${BOOKING_ID}/start`, {});
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ bookingId: BOOKING_ID, status: "not_started" });
    expect(control.startCharging).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      BOOKING_ID,
      undefined,
    );
    await send("POST", `/bookings/${BOOKING_ID}/start`, { startAt: "2027-01-13T00:00:00+00:00" });
    expect(vi.mocked(control.startCharging).mock.calls.at(-1)?.[3]).toEqual(
      new Date("2027-01-13T00:00:00Z"),
    );
    expect(
      (await send("POST", `/bookings/${BOOKING_ID}/start`, { startAt: "tonight" })).statusCode,
    ).toBe(400);

    const stopped = await send("POST", `/bookings/${BOOKING_ID}/stop`);
    expect(stopped.statusCode).toBe(200);
    expect(control.stopCharging).toHaveBeenCalledWith(expect.anything(), USER_ID, BOOKING_ID);
  });

  it("serves the live session and passes problems through", async () => {
    expect((await send("GET", `/bookings/${BOOKING_ID}/session`)).json()).toMatchObject({
      status: "not_started",
      currency: "EUR",
    });
    vi.mocked(control.stopCharging).mockRejectedValue(
      new HttpProblem(503, "charger-unreachable", "The charger didn't respond"),
    );
    const failed = await send("POST", `/bookings/${BOOKING_ID}/stop`);
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ code: "charger-unreachable" });
    expect(
      (await app.inject({ method: "GET", url: `/bookings/${BOOKING_ID}/session` })).statusCode,
    ).toBe(401);
  });
});
