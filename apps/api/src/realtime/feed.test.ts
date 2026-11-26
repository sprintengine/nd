import { CHARGER_EVENT_VERSION, type ChargerEvent } from "@nd/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_ID, CHARGER_ID, HOST_USER_ID } from "../../test/booking-detail.ts";
import { FakeHubSocket } from "../../test/hub-socket.ts";
import { DRIVER_ID, IN_SLOT, SESSION_ID, sessionContext } from "../../test/session-context.ts";
import * as data from "../data/sessions.ts";
import { changedBooking, createRealtimeFeed, type RealtimeFeed } from "./feed.ts";
import { createRealtimeHub, type RealtimeHub } from "./hub.ts";

vi.mock("../data/sessions.ts");

const base = {
  v: CHARGER_EVENT_VERSION,
  at: "2027-01-12T22:10:00.000Z",
  chargerId: CHARGER_ID,
  chargeboxId: "NDTEST0001",
} as const;

let hub: RealtimeHub;
let feed: RealtimeFeed;
let driver: FakeHubSocket;
let host: FakeHubSocket;
let other: FakeHubSocket;
const warnings: string[] = [];

const event = (value: ChargerEvent) => {
  feed.handle({ kind: "event", event: value });
};
const typesSent = (socket: FakeHubSocket) =>
  socket.sent.map((message) => (message as { type: string }).type);

beforeEach(() => {
  vi.resetAllMocks();
  warnings.length = 0;
  hub = createRealtimeHub({
    maxConnectionsPerUser: 5,
    heartbeatMs: 60_000,
    maxBufferedBytes: 1_000_000,
    revalidateEveryBeats: 10,
    log: { warn: () => undefined },
  });
  feed = createRealtimeFeed({
    db: {} as never,
    clock: { now: () => IN_SLOT },
    hub,
    log: { warn: (_details, message) => warnings.push(message) },
  });
  [driver, host, other] = [new FakeHubSocket(), new FakeHubSocket(), new FakeHubSocket()];
  hub.add(DRIVER_ID, driver, () => Promise.resolve(true));
  hub.add(HOST_USER_ID, host, () => Promise.resolve(true));
  hub.add("user-sam", other, () => Promise.resolve(true));
  vi.mocked(data.bookingAudience).mockResolvedValue({
    driverId: DRIVER_ID,
    hostUserId: HOST_USER_ID,
    status: "active",
  });
  vi.mocked(data.findSessionContext).mockResolvedValue(
    sessionContext({ session: { status: "charging", ocppTransactionId: 1 } }),
  );
  vi.mocked(data.bookingOfSession).mockResolvedValue(BOOKING_ID);
  vi.mocked(data.chargerAudience).mockResolvedValue({ hostUserId: HOST_USER_ID, status: "online" });
});

afterEach(() => {
  hub.close();
});

describe("realtime feed", () => {
  it("pushes booking and session updates to the driver and host on session events", async () => {
    event({
      ...base,
      type: "session_started",
      sessionId: SESSION_ID,
      bookingId: BOOKING_ID,
      transactionId: 1,
      meterStartWh: 0,
    });
    await feed.idle();
    for (const socket of [driver, host]) {
      expect(socket.sent).toEqual([
        {
          type: "booking:update",
          bookingId: BOOKING_ID,
          status: "active",
          at: IN_SLOT.toISOString(),
        },
        expect.objectContaining({
          type: "session:update",
          bookingId: BOOKING_ID,
          status: "charging",
        }),
      ]);
    }
    expect(other.sent).toEqual([]);
  });

  it("pushes meter readings and status changes, and charger status to the host only", async () => {
    event({
      ...base,
      type: "meter",
      sessionId: SESSION_ID,
      transactionId: 1,
      ts: base.at,
      energyWh: 10,
      powerW: 7000,
    });
    event({
      ...base,
      type: "status",
      connectorId: 1,
      status: "SuspendedEV",
      errorCode: "NoError",
      sessionId: SESSION_ID,
      sessionStatus: "suspended_ev",
    });
    event({ ...base, type: "fault", connectorId: 1, errorCode: "GroundFailure" });
    event({ ...base, type: "offline", lastHeartbeatAt: null });
    await feed.idle();
    expect(typesSent(driver)).toEqual(["session:update", "session:update"]);
    expect(typesSent(host)).toEqual([
      "session:update",
      "charger:status",
      "session:update",
      "charger:status",
      "charger:status",
    ]);
    expect(host.sent[1]).toEqual({
      type: "charger:status",
      chargerId: CHARGER_ID,
      status: "online",
      connectorStatus: "SuspendedEV",
      errorCode: "NoError",
      at: base.at,
    });
    expect(host.sent[3]).toMatchObject({ connectorStatus: null, errorCode: "GroundFailure" });
    expect(host.sent[4]).toMatchObject({ connectorStatus: null, errorCode: null });
  });

  it("reads nothing more for bookings and chargers nobody is watching", async () => {
    hub.close();
    event({ ...base, type: "boot", firmware: null });
    event({ ...base, type: "status", connectorId: 1, status: "Available", errorCode: "NoError" });
    feed.bookingChanged(BOOKING_ID);
    feed.sessionChanged(BOOKING_ID);
    await feed.idle();
    expect(data.findSessionContext).toHaveBeenCalledTimes(1);
    expect(data.bookingOfSession).not.toHaveBeenCalled();
  });

  it("skips unknown rows and logs a failed update without throwing", async () => {
    vi.mocked(data.bookingAudience).mockResolvedValueOnce(undefined);
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(undefined);
    vi.mocked(data.chargerAudience).mockResolvedValueOnce(undefined);
    vi.mocked(data.bookingOfSession).mockResolvedValueOnce(undefined);
    feed.bookingChanged(BOOKING_ID);
    feed.sessionChanged(BOOKING_ID);
    event({ ...base, type: "online" });
    event({
      ...base,
      type: "meter",
      sessionId: SESSION_ID,
      transactionId: null,
      ts: base.at,
      energyWh: null,
      powerW: null,
    });
    vi.mocked(data.bookingAudience).mockRejectedValueOnce(new Error("db down"));
    feed.bookingChanged(BOOKING_ID);
    feed.bookingChanged(BOOKING_ID);
    await feed.idle();
    expect(warnings).toEqual(["realtime update failed"]);
    expect(typesSent(driver)).toEqual(["booking:update"]);
  });

  it("tells everyone to refetch after a resync", () => {
    feed.handle({ kind: "resync" });
    for (const socket of [driver, host, other]) expect(socket.sent).toEqual([{ type: "resync" }]);
  });
});

describe("changedBooking", () => {
  const route = { method: "POST", statusCode: 200, params: { id: BOOKING_ID } };

  it("names the booking a successful booking route changed", () => {
    expect(changedBooking({ ...route, url: "/bookings/:id/cancel" }, "{}")).toBe(BOOKING_ID);
    expect(
      changedBooking(
        { ...route, url: "/bookings", params: {}, statusCode: 201 },
        `{"id":"${BOOKING_ID}"}`,
      ),
    ).toBe(BOOKING_ID);
  });

  it("ignores other routes, methods, failures and bodies without an id", () => {
    expect(
      changedBooking({ ...route, url: "/bookings/:id/session", method: "GET" }, ""),
    ).toBeUndefined();
    expect(changedBooking({ ...route, url: "/chargers" }, "")).toBeUndefined();
    expect(changedBooking({ ...route, url: undefined }, "")).toBeUndefined();
    expect(
      changedBooking({ ...route, url: "/bookings/:id/cancel", statusCode: 409 }, ""),
    ).toBeUndefined();
    const create = { ...route, url: "/bookings", params: undefined };
    expect(changedBooking(create, "not json")).toBeUndefined();
    expect(changedBooking(create, "{}")).toBeUndefined();
    expect(changedBooking(create, Buffer.from("{}"))).toBeUndefined();
  });
});
