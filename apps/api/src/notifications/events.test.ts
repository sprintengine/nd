import { beforeEach, describe, expect, it, vi } from "vitest";

import { unitServices } from "../../test/services.ts";
import * as data from "../data/notifications.ts";
import { notificationEventHandler } from "./events.ts";
import { queueNotification } from "./queue.ts";

vi.mock("../data/notifications.ts");

const CHARGER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2027-01-12T22:00:00Z");

beforeEach(() => {
  vi.resetAllMocks();
});

describe("notificationEventHandler", () => {
  it("queues a fault notification keyed by the report", async () => {
    const { services, jobs } = unitServices(NOW);
    const at = "2027-01-12T21:59:00.000Z";
    await notificationEventHandler(services).handle({
      kind: "event",
      event: {
        v: 1,
        type: "fault",
        at,
        chargerId: CHARGER_ID,
        chargeboxId: "zappi-1",
        connectorId: 1,
        errorCode: "GroundFailure",
      },
    });
    expect(jobs.sent).toEqual([
      {
        name: "notify",
        payload: { type: "charger_faulted", chargerId: CHARGER_ID, errorCode: "GroundFailure", at },
        options: { singletonKey: `charger:${CHARGER_ID}:fault:${at}` },
      },
    ]);
  });

  it("queues offline alerts again after a reconnect, no sooner than 10 minutes in", async () => {
    const { services, jobs } = unitServices(NOW);
    vi.mocked(data.offlineChargers).mockResolvedValue([
      { id: CHARGER_ID, lastHeartbeatAt: new Date("2027-01-12T21:55:00Z") },
      { id: OTHER_ID, lastHeartbeatAt: null },
    ] as never);
    await notificationEventHandler(services).handle({ kind: "resync" });
    expect(jobs.sent.map((job) => [job.payload, job.options.startAfter])).toEqual([
      [
        {
          type: "charger_offline",
          chargerId: CHARGER_ID,
          lastHeartbeatAt: "2027-01-12T21:55:00.000Z",
        },
        new Date("2027-01-12T22:05:00Z"),
      ],
      [{ type: "charger_offline", chargerId: OTHER_ID, lastHeartbeatAt: null }, undefined],
    ]);
  });
});

describe("queueNotification", () => {
  it("logs rather than throws when the job cannot be queued", async () => {
    const warn = vi.fn();
    const log = { info: vi.fn(), warn, error: vi.fn() };
    const jobs = { send: vi.fn().mockRejectedValue(new Error("database down")) };
    await queueNotification(
      { jobs, log },
      { type: "guest_arrived", bookingId: "11111111-1111-4111-8111-111111111111" },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ notification: "guest_arrived" }),
      "queueing a notification failed",
    );
  });
});
