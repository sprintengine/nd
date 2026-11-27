import { describe, expect, it, vi } from "vitest";

import { recordingPush } from "../../test/fakes.ts";
import { unitServices } from "../../test/services.ts";
import * as data from "../data/notifications.ts";
import { notificationsPruneJob, notifyJob } from "./jobs.ts";

vi.mock("../data/notifications.ts");

describe("notification jobs", () => {
  it("prune records older than 90 days, daily", async () => {
    const { services } = unitServices(new Date("2027-04-01T04:30:00Z"));
    vi.mocked(data.pruneNotifications).mockResolvedValue(3);
    await notificationsPruneJob.run(
      {},
      { ...services, push: recordingPush().push },
      {
        jobId: "1",
        retryCount: 0,
        lastAttempt: true,
      },
    );
    expect(data.pruneNotifications).toHaveBeenCalledWith(
      expect.anything(),
      new Date("2027-01-01T04:30:00Z"),
    );
    expect(notificationsPruneJob.cron).toBe("30 4 * * *");
  });

  it("notify delivers the trigger it is given", async () => {
    const { services } = unitServices(new Date("2027-01-12T22:00:00Z"));
    vi.mocked(data.notificationBooking).mockResolvedValue(undefined);
    await notifyJob.run(
      { type: "guest_arrived", bookingId: "11111111-1111-4111-8111-111111111111" },
      { ...services, push: recordingPush().push },
      { jobId: "1", retryCount: 0, lastAttempt: false },
    );
    expect(data.notificationBooking).toHaveBeenCalled();
  });
});
