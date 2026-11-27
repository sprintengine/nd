import { describe, expect, it, vi } from "vitest";

import { BOOKING_ID } from "../../test/booking-detail.ts";
import { SESSION_ID, sessionServices } from "../../test/session-context.ts";
import * as control from "./control.ts";
import { remoteStartJob, SESSION_JOBS, startTimeoutJob, windowEndStopJob } from "./jobs.ts";

vi.mock("./control.ts");

describe("session jobs", () => {
  it("run session control with their payloads", async () => {
    const { services } = sessionServices();
    const attempt = { jobId: "j", retryCount: 0, lastAttempt: false };
    expect(SESSION_JOBS.map((job) => job.name)).toEqual([
      "session-remote-start",
      "session-start-timeout",
      "session-window-end-stop",
    ]);
    await remoteStartJob.run({ bookingId: BOOKING_ID }, services, attempt);
    expect(control.runRemoteStart).toHaveBeenCalledWith(
      services,
      { bookingId: BOOKING_ID },
      attempt,
    );
    await startTimeoutJob.run({ bookingId: BOOKING_ID, sessionId: SESSION_ID }, services, attempt);
    expect(control.failStalledStart).toHaveBeenCalledWith(services, {
      bookingId: BOOKING_ID,
      sessionId: SESSION_ID,
    });
    await windowEndStopJob.run({ bookingId: BOOKING_ID }, services, attempt);
    expect(control.stopAtWindowEnd).toHaveBeenCalledWith(services, BOOKING_ID, attempt);
  });
});
