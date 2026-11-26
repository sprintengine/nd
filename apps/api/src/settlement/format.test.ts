import { describe, expect, it } from "vitest";

import {
  closedSessionDriverEmail,
  closedSessionHostEmail,
  type ClosedSessionNotice,
} from "./emails.ts";
import {
  formatDateTime,
  formatDuration,
  formatKwh,
  formatMoney,
  formatPeriod,
  formatTime,
} from "./format.ts";

describe("format", () => {
  it("writes money from cents without floats", () => {
    expect(formatMoney(917, "EUR")).toBe("€9.17");
    expect(formatMoney(5, "GBP")).toBe("£0.05");
    expect(formatMoney(-117, "EUR")).toBe("-€1.17");
  });

  it("writes energy, durations and times in the charger's zone", () => {
    expect(formatKwh(22.5)).toBe("22.5 kWh");
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(120)).toBe("2 h");
    expect(formatDuration(220)).toBe("3 h 40 min");
    const start = new Date("2027-07-12T21:00:00Z");
    expect(formatTime(start, "Europe/Dublin")).toBe("22:00");
    expect(formatDateTime(start, "Europe/Dublin")).toMatch(/Mon,? 12 Jul,? 22:00/);
    expect(formatPeriod(start, new Date("2027-07-13T00:39:00Z"), "Europe/Dublin")).toMatch(
      /22:00–01:39$/,
    );
  });
});

describe("closed session emails", () => {
  const notice: ClosedSessionNotice = {
    bookingId: "b1",
    driver: { name: "Cian Byrne", email: "cian@example.com" },
    host: { name: "Niamh", email: "niamh@example.com" },
    startedAt: new Date("2027-01-12T22:00:00Z"),
    stoppedAt: new Date("2027-01-13T01:30:00Z"),
    kwh: 21,
    timezone: "Europe/Dublin",
    confirmationDueAt: new Date("2027-01-16T02:10:00Z"),
  };

  it("tells the driver when they will be charged", () => {
    const mail = closedSessionDriverEmail(notice);
    expect(mail.to).toBe("cian@example.com");
    expect(mail.text).toContain("Hi Cian,");
    expect(mail.text).toContain("21.0 kWh");
    expect(mail.text).toContain("only after they confirm");
  });

  it("asks the host to confirm or dispute", () => {
    const mail = closedSessionHostEmail(notice);
    expect(mail.to).toBe("niamh@example.com");
    expect(mail.subject).toBe("Please confirm a charging session");
    expect(mail.text).toContain("confirm the session in the app, or dispute it");
  });
});
