import { DEFAULT_NOTIFICATION_PREFERENCES } from "@nd/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { recordingPush } from "../../test/fakes.ts";
import { unitServices } from "../../test/services.ts";
import * as data from "../data/notifications.ts";
import type { PushDevice } from "../push/push.ts";
import { deliverNotifications, type NotificationServices, PushRetryError } from "./deliver.ts";

vi.mock("../data/notifications.ts");

const BOOKING_ID = "11111111-1111-4111-8111-111111111111";
const CHARGER_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2027-01-12T22:00:00Z");

const device = (id: string, platform: PushDevice["platform"] = "ios"): PushDevice => ({
  id,
  platform,
  token: `token-${id}`,
  webPush: null,
});

function setUp() {
  const push = recordingPush();
  const { services } = unitServices(NOW);
  const notify: NotificationServices = { ...services, push: push.push };
  vi.mocked(data.notificationBooking).mockResolvedValue({
    id: BOOKING_ID,
    chargerId: CHARGER_ID,
    status: "requested",
    slot: { start: new Date("2027-01-12T22:00:00Z"), end: new Date("2027-01-13T07:00:00Z") },
    cancelledBy: null,
    driverId: "user-driver",
    hostUserId: "user-host",
    timezone: "Europe/Dublin",
  });
  vi.mocked(data.preferencesOf).mockResolvedValue(DEFAULT_NOTIFICATION_PREFERENCES);
  vi.mocked(data.claimNotification).mockResolvedValue("ledger-1");
  vi.mocked(data.devicesOf).mockResolvedValue([device("a"), device("b")]);
  vi.mocked(data.notifiedSince).mockResolvedValue(false);
  return { push, services: notify };
}

let t: ReturnType<typeof setUp>;
beforeEach(() => {
  vi.resetAllMocks();
  t = setUp();
});

describe("deliverNotifications", () => {
  it("pushes to every device of the recipient and records it delivered", async () => {
    const results = await deliverNotifications(t.services, {
      type: "booking_created",
      bookingId: BOOKING_ID,
    });
    expect(results).toEqual(["delivered"]);
    expect(t.push.sent.map((sent) => sent.device.id)).toEqual(["a", "b"]);
    expect(t.push.sent[0]?.message).toMatchObject({ title: "New booking request" });
    expect(data.claimNotification).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-host",
      kind: "booking_requested",
      eventKey: `booking:${BOOKING_ID}:booking_requested`,
    });
    expect(data.markDelivered).toHaveBeenCalledWith(expect.anything(), "ledger-1", NOW);
  });

  it("sends nothing twice", async () => {
    vi.mocked(data.claimNotification).mockResolvedValue(undefined);
    expect(
      await deliverNotifications(t.services, { type: "booking_created", bookingId: BOOKING_ID }),
    ).toEqual(["already_delivered"]);
    expect(t.push.sent).toEqual([]);
  });

  it("respects a switch the user turned off", async () => {
    vi.mocked(data.preferencesOf).mockResolvedValue({
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      bookingRequests: false,
    });
    expect(
      await deliverNotifications(t.services, { type: "booking_created", bookingId: BOOKING_ID }),
    ).toEqual(["turned_off"]);
    expect(data.claimNotification).not.toHaveBeenCalled();
    expect(t.push.sent).toEqual([]);
  });

  it("records a notification for a user with no devices as done", async () => {
    vi.mocked(data.devicesOf).mockResolvedValue([]);
    expect(
      await deliverNotifications(t.services, { type: "booking_created", bookingId: BOOKING_ID }),
    ).toEqual(["no_devices"]);
    expect(data.markDelivered).toHaveBeenCalled();
  });

  it("forgets devices whose tokens are invalid", async () => {
    t.push.answer("token-a", { status: "invalid_token" });
    expect(
      await deliverNotifications(t.services, { type: "booking_created", bookingId: BOOKING_ID }),
    ).toEqual(["delivered"]);
    expect(data.removeDevices).toHaveBeenCalledWith(expect.anything(), ["a"]);
  });

  it("gives up on a push no device can take, and retries one worth retrying", async () => {
    t.push.answer("token-a", { status: "invalid_token" });
    t.push.answer("token-b", { status: "failed", retryable: false, reason: "bad" });
    expect(
      await deliverNotifications(t.services, { type: "booking_created", bookingId: BOOKING_ID }),
    ).toEqual(["undeliverable"]);
    expect(data.markDelivered).toHaveBeenCalled();

    vi.mocked(data.markDelivered).mockClear();
    t.push.answer("token-b", { status: "failed", retryable: true, reason: "server-unavailable" });
    await expect(
      deliverNotifications(t.services, { type: "booking_created", bookingId: BOOKING_ID }),
    ).rejects.toThrow(PushRetryError);
    expect(data.markDelivered).not.toHaveBeenCalled();
  });

  it("does nothing for a booking or session that is gone", async () => {
    vi.mocked(data.notificationBooking).mockResolvedValue(undefined);
    expect(
      await deliverNotifications(t.services, { type: "guest_arrived", bookingId: BOOKING_ID }),
    ).toEqual([]);
    t = setUp();
    vi.mocked(data.notificationSession).mockResolvedValue(undefined);
    expect(
      await deliverNotifications(t.services, {
        type: "session_started",
        bookingId: BOOKING_ID,
        sessionId: SESSION_ID,
      }),
    ).toEqual([]);
  });

  it("includes the host's earnings once settled", async () => {
    vi.mocked(data.notificationSession).mockResolvedValue({
      id: SESSION_ID,
      bookingId: BOOKING_ID,
      status: "reconciled",
      kwh: 7.2,
      stopReason: null,
    });
    vi.mocked(data.settledAmounts).mockResolvedValue({
      billedCents: 1600,
      earningsCents: 1500,
      currency: "EUR",
    });
    await deliverNotifications(t.services, {
      type: "session_settled",
      bookingId: BOOKING_ID,
      sessionId: SESSION_ID,
    });
    expect(t.push.sent[0]?.message.body).toBe(
      "Your guest paid €16.00 and charged 7.2 kWh. You receive €15.00 after card fees.",
    );
    expect(data.settledAmounts).toHaveBeenCalledWith(expect.anything(), BOOKING_ID);
  });

  it("does not look up earnings for the driver's notifications", async () => {
    vi.mocked(data.notificationSession).mockResolvedValue({
      id: SESSION_ID,
      bookingId: BOOKING_ID,
      status: "charging",
      kwh: null,
      stopReason: null,
    });
    await deliverNotifications(t.services, {
      type: "session_started",
      bookingId: BOOKING_ID,
      sessionId: SESSION_ID,
    });
    expect(data.settledAmounts).not.toHaveBeenCalled();
    expect(t.push.sent).toHaveLength(4);
  });

  describe("charger alerts", () => {
    const faulted = {
      type: "charger_faulted",
      chargerId: CHARGER_ID,
      errorCode: "GroundFailure",
      at: "2027-01-12T21:59:00.000Z",
    } as const;
    beforeEach(() => {
      vi.mocked(data.chargerForAlert).mockResolvedValue({
        id: CHARGER_ID,
        hostUserId: "user-host",
        status: "offline",
        lastHeartbeatAt: new Date("2027-01-12T21:40:00Z"),
      });
    });

    it("tells the host about a fault, once within the cooldown", async () => {
      expect(await deliverNotifications(t.services, faulted)).toEqual(["delivered"]);
      expect(data.notifiedSince).toHaveBeenCalledWith(
        expect.anything(),
        "user-host",
        `charger:${CHARGER_ID}:fault:`,
        new Date("2027-01-12T21:30:00Z"),
        `charger:${CHARGER_ID}:fault:${faulted.at}:charger_faulted`,
      );
      vi.mocked(data.notifiedSince).mockResolvedValue(true);
      expect(await deliverNotifications(t.services, faulted)).toEqual(["cooling_down"]);
    });

    it("reports an offline spell only while it lasts", async () => {
      const offline = {
        type: "charger_offline",
        chargerId: CHARGER_ID,
        lastHeartbeatAt: "2027-01-12T21:40:00.000Z",
      } as const;
      expect(await deliverNotifications(t.services, offline)).toEqual(["delivered"]);
      vi.mocked(data.chargerForAlert).mockResolvedValue({
        id: CHARGER_ID,
        hostUserId: "user-host",
        status: "online",
        lastHeartbeatAt: new Date("2027-01-12T21:55:00Z"),
      });
      expect(await deliverNotifications(t.services, offline)).toEqual([]);
      vi.mocked(data.chargerForAlert).mockResolvedValue(undefined);
      expect(await deliverNotifications(t.services, faulted)).toEqual([]);
    });
  });
});
