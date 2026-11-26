import { describe, expect, it } from "vitest";

import {
  authorisationPlan,
  AUTHORISE_NOW_HORIZON_DAYS,
  billableMinutes,
  billedAmount,
  billingBreakdown,
  cancellationFee,
  centsPerKwh,
  divideRoundHalfEven,
  hostShare,
  minutesCost,
  noShowAt,
  noShowFee,
  platformFee,
  quote,
  slotMinutes,
} from "./pricing.ts";

const at = (iso: string) => new Date(iso);
const minutesAfter = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);
const START = at("2027-01-11T22:00:00Z");

describe("divideRoundHalfEven", () => {
  it.each([
    [0, 7, 0],
    [10, 5, 2],
    [11, 5, 2],
    [13, 5, 3],
    [5, 2, 2],
    [7, 2, 4],
    [25, 10, 2],
    [35, 10, 4],
    [26, 10, 3],
  ])("%d / %d rounds to %d", (numerator, denominator, expected) => {
    expect(divideRoundHalfEven(numerator, denominator)).toBe(expected);
  });

  it.each([
    [-1, 2],
    [1.5, 2],
    [Number.MAX_SAFE_INTEGER + 1, 2],
    [1, 0],
    [1, -2],
    [1, 0.5],
  ])("rejects %d / %d", (numerator, denominator) => {
    expect(() => divideRoundHalfEven(numerator, denominator)).toThrow(RangeError);
  });
});

describe("billableMinutes", () => {
  it.each([
    [0, 0],
    [1, 5],
    [5, 5],
    [5.01, 10],
    [219, 220],
  ])("bills %d minutes as %d", (actual, billed) => {
    expect(billableMinutes(actual)).toBe(billed);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects %d", (actual) => {
    expect(() => billableMinutes(actual)).toThrow(RangeError);
  });
});

describe("minutesCost", () => {
  it("prorates the hourly price by the minute", () => {
    expect(minutesCost(60, 250)).toBe(250);
    expect(minutesCost(1, 250)).toBe(4); // 4.1666…
    expect(minutesCost(6, 25)).toBe(2); // 2.5 rounds to even
    expect(minutesCost(18, 25)).toBe(8); // 7.5 rounds to even
  });

  it.each([
    [-1, 250],
    [1.5, 250],
    [10, -1],
    [10, 2.5],
  ])("rejects %d minutes at %d", (minutes, price) => {
    expect(() => minutesCost(minutes, price)).toThrow(RangeError);
  });
});

describe("slotMinutes", () => {
  it("counts whole minutes", () => {
    expect(slotMinutes({ start: START, end: minutesAfter(START, 90) })).toBe(90);
  });

  it("rejects empty, reversed, fractional and invalid slots", () => {
    expect(() => slotMinutes({ start: START, end: START })).toThrow(RangeError);
    expect(() => slotMinutes({ start: START, end: minutesAfter(START, -5) })).toThrow(RangeError);
    expect(() => slotMinutes({ start: START, end: new Date(START.getTime() + 90_500) })).toThrow(
      RangeError,
    );
    expect(() => slotMinutes({ start: new Date(Number.NaN), end: START })).toThrow(RangeError);
    expect(() => slotMinutes({ start: START, end: new Date(Number.NaN) })).toThrow(RangeError);
  });
});

describe("quote", () => {
  it("prices 4 hours at €2.50 at 1000 cents, with nothing added", () => {
    expect(quote({ start: START, end: minutesAfter(START, 240) }, 250)).toBe(1000);
  });

  it("prorates partial hours by the minute", () => {
    expect(quote({ start: START, end: minutesAfter(START, 90) }, 250)).toBe(375);
    expect(quote({ start: START, end: minutesAfter(START, 61) }, 250)).toBe(254); // 254.1666…
    expect(quote({ start: START, end: minutesAfter(START, 30) }, 0)).toBe(0);
  });
});

describe("billedAmount", () => {
  it("rounds the time used up to 5 minutes", () => {
    // 62 minutes is billed as 65: 65 × 250 / 60 = 270.83…
    expect(billedAmount(START, minutesAfter(START, 62), 250, 1000)).toBe(271);
    expect(billedAmount(START, minutesAfter(START, 60), 250, 1000)).toBe(250);
    expect(billedAmount(START, START, 250, 1000)).toBe(0);
  });

  it("never bills more than the quote", () => {
    expect(billedAmount(START, minutesAfter(START, 300), 250, 1000)).toBe(1000);
    expect(billedAmount(START, minutesAfter(START, 239), 250, 1000)).toBe(1000);
  });

  it("rejects a stop before the start and invalid input", () => {
    expect(() => billedAmount(START, minutesAfter(START, -1), 250, 1000)).toThrow(RangeError);
    expect(() => billedAmount(new Date(Number.NaN), START, 250, 1000)).toThrow(RangeError);
    expect(() => billedAmount(START, new Date(Number.NaN), 250, 1000)).toThrow(RangeError);
    expect(() => billedAmount(START, START, 250, -1)).toThrow(RangeError);
  });
});

describe("cancellationFee", () => {
  const policy = { pricePerHourCents: 250, quoteCents: 1000 };

  it("is free until the default cutoff of 2 hours before the start", () => {
    expect(cancellationFee(policy, minutesAfter(START, -121), START)).toEqual({
      feeCents: 0,
      afterCutoff: false,
    });
  });

  it("charges one hour from the cutoff on", () => {
    expect(cancellationFee(policy, minutesAfter(START, -120), START)).toEqual({
      feeCents: 250,
      afterCutoff: true,
    });
    expect(cancellationFee(policy, minutesAfter(START, 30), START).feeCents).toBe(250);
  });

  it("uses the host's cutoff", () => {
    const strict = { ...policy, cutoffMinutes: 24 * 60 };
    expect(cancellationFee(strict, minutesAfter(START, -23 * 60), START).feeCents).toBe(250);
    const lenient = { ...policy, cutoffMinutes: 0 };
    expect(cancellationFee(lenient, minutesAfter(START, -1), START).feeCents).toBe(0);
  });

  it("caps the fee at the quote", () => {
    expect(
      cancellationFee({ pricePerHourCents: 250, quoteCents: 125 }, START, START).feeCents,
    ).toBe(125);
  });

  it("rejects invalid input", () => {
    expect(() => cancellationFee({ ...policy, cutoffMinutes: -1 }, START, START)).toThrow(
      RangeError,
    );
    expect(() => cancellationFee({ ...policy, cutoffMinutes: 1.5 }, START, START)).toThrow(
      RangeError,
    );
    expect(() => cancellationFee({ ...policy, quoteCents: -1 }, START, START)).toThrow(RangeError);
    expect(() => cancellationFee(policy, new Date(Number.NaN), START)).toThrow(RangeError);
  });
});

describe("noShowFee", () => {
  it("is one hour, capped at the quote", () => {
    expect(noShowFee({ pricePerHourCents: 250, quoteCents: 1000 })).toBe(250);
    expect(noShowFee({ pricePerHourCents: 250, quoteCents: 100 })).toBe(100);
    expect(() => noShowFee({ pricePerHourCents: -1, quoteCents: 100 })).toThrow(RangeError);
  });
});

describe("platformFee", () => {
  it("defaults to nothing", () => {
    expect(platformFee(1000)).toBe(0);
    expect(hostShare(1000)).toBe(1000);
  });

  it("takes basis points, rounding half to even", () => {
    expect(platformFee(1000, 1000)).toBe(100);
    expect(platformFee(125, 1000)).toBe(12); // 12.5
    expect(platformFee(135, 1000)).toBe(14); // 13.5
    expect(hostShare(1000, 1500)).toBe(850);
  });

  it.each([-1, 10_001, 2.5])("rejects %d bps", (bps) => {
    expect(() => platformFee(1000, bps)).toThrow(RangeError);
  });
});

describe("authorisationPlan", () => {
  it("authorises at once when the slot starts within 6 days", () => {
    const now = minutesAfter(START, -AUTHORISE_NOW_HORIZON_DAYS * 24 * 60);
    expect(authorisationPlan(now, START)).toEqual({ kind: "authorise_now" });
  });

  it("saves the card and authorises 24 hours ahead for later slots", () => {
    const now = minutesAfter(START, -AUTHORISE_NOW_HORIZON_DAYS * 24 * 60 - 1);
    expect(authorisationPlan(now, START)).toEqual({
      kind: "save_card",
      authoriseAt: at("2027-01-10T22:00:00Z"),
    });
  });

  it("rejects invalid dates", () => {
    expect(() => authorisationPlan(new Date(Number.NaN), START)).toThrow(RangeError);
  });
});

describe("noShowAt", () => {
  it("is 15 minutes after the slot ends", () => {
    expect(noShowAt(START)).toEqual(at("2027-01-11T22:15:00Z"));
    expect(() => noShowAt(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("billingBreakdown", () => {
  it("shows 3 h 39 min at 250 cents an hour billed as 3 h 40 min, under a 4-hour quote", () => {
    const stop = minutesAfter(START, 219);
    const breakdown = billingBreakdown(START, stop, 250, 1000);
    expect(breakdown).toEqual({
      actualMinutes: 219,
      billedMinutes: 220,
      timeCostCents: 917,
      capped: false,
      amountCents: 917,
    });
    expect(breakdown.amountCents).toBe(billedAmount(START, stop, 250, 1000));
  });

  it("notes when the quote caps the amount", () => {
    const breakdown = billingBreakdown(START, minutesAfter(START, 241), 250, 1000);
    expect(breakdown).toMatchObject({ billedMinutes: 245, timeCostCents: 1021, capped: true });
    expect(breakdown.amountCents).toBe(1000);
  });

  it("rounds part of a minute up", () => {
    const stop = new Date(START.getTime() + 61_000);
    expect(billingBreakdown(START, stop, 600, 1000)).toMatchObject({
      actualMinutes: 2,
      billedMinutes: 5,
      amountCents: 50,
    });
  });
});

describe("centsPerKwh", () => {
  it("divides the amount by the energy delivered", () => {
    expect(centsPerKwh(917, 22_500)).toBe(41);
    expect(centsPerKwh(1000, 1000)).toBe(1000);
  });

  it("is undefined when nothing was delivered", () => {
    expect(centsPerKwh(917, 0)).toBeUndefined();
  });

  it("refuses negative or fractional energy", () => {
    expect(() => centsPerKwh(917, -1)).toThrow(RangeError);
    expect(() => centsPerKwh(917, 1.5)).toThrow(RangeError);
    expect(() => centsPerKwh(-1, 100)).toThrow(RangeError);
  });
});
