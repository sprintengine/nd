import { describe, expect, it } from "vitest";

import {
  cancellationRefund,
  centsPerKwh,
  chargeSplit,
  DEFAULT_CARD_FEE_BPS,
  DEFAULT_CARD_FEE_FIXED_CENTS,
  divideRoundHalfEven,
  divideRoundUp,
  hostEarnings,
  minutesCost,
  noShowAt,
  quote,
  requestExpiresAt,
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

describe("divideRoundUp", () => {
  it("rounds any remainder up", () => {
    expect(divideRoundUp(10, 5)).toBe(2);
    expect(divideRoundUp(11, 5)).toBe(3);
    expect(divideRoundUp(0, 7)).toBe(0);
  });

  it("rejects negative, fractional or zero operands", () => {
    expect(() => divideRoundUp(-1, 5)).toThrow(RangeError);
    expect(() => divideRoundUp(1.5, 5)).toThrow(RangeError);
    expect(() => divideRoundUp(1, 0)).toThrow(RangeError);
    expect(() => divideRoundUp(1, 2.5)).toThrow(RangeError);
  });
});

const DEFAULT_FEES = {
  platformFeeBps: 0,
  cardFeeBps: DEFAULT_CARD_FEE_BPS,
  cardFeeFixedCents: DEFAULT_CARD_FEE_FIXED_CENTS,
};

describe("chargeSplit", () => {
  it("passes 1.5 % plus 25 cents on to the host by default, with no platform fee", () => {
    expect(chargeSplit(1000, DEFAULT_FEES)).toEqual({
      amountCents: 1000,
      platformFeeCents: 0,
      cardFeeCents: 40,
      applicationFeeCents: 40,
      hostNetCents: 960,
    });
  });

  it("rounds the card fee up to the next cent", () => {
    // 1.5 % of 1001 is 15.015 cents.
    expect(chargeSplit(1001, DEFAULT_FEES)).toMatchObject({ cardFeeCents: 41, hostNetCents: 960 });
  });

  it("adds a configured platform fee, rounded up, to the application fee", () => {
    expect(chargeSplit(1000, { ...DEFAULT_FEES, platformFeeBps: 1000 })).toEqual({
      amountCents: 1000,
      platformFeeCents: 100,
      cardFeeCents: 40,
      applicationFeeCents: 140,
      hostNetCents: 860,
    });
    expect(chargeSplit(1001, { ...DEFAULT_FEES, platformFeeBps: 1 }).platformFeeCents).toBe(1);
  });

  it("never takes more than the price", () => {
    expect(chargeSplit(20, DEFAULT_FEES)).toMatchObject({
      cardFeeCents: 20,
      applicationFeeCents: 20,
      hostNetCents: 0,
    });
    expect(chargeSplit(100, { ...DEFAULT_FEES, platformFeeBps: 10_000 })).toMatchObject({
      platformFeeCents: 100,
      cardFeeCents: 0,
      hostNetCents: 0,
    });
    expect(chargeSplit(0, DEFAULT_FEES).hostNetCents).toBe(0);
  });

  it("takes nothing when every fee is 0", () => {
    expect(chargeSplit(999, { platformFeeBps: 0, cardFeeBps: 0, cardFeeFixedCents: 0 })).toEqual({
      amountCents: 999,
      platformFeeCents: 0,
      cardFeeCents: 0,
      applicationFeeCents: 0,
      hostNetCents: 999,
    });
  });

  it("rejects invalid amounts and settings", () => {
    expect(() => chargeSplit(-1, DEFAULT_FEES)).toThrow(RangeError);
    expect(() => chargeSplit(1.5, DEFAULT_FEES)).toThrow(RangeError);
    expect(() => chargeSplit(100, { ...DEFAULT_FEES, platformFeeBps: -1 })).toThrow(RangeError);
    expect(() => chargeSplit(100, { ...DEFAULT_FEES, cardFeeBps: 10_001 })).toThrow(RangeError);
    expect(() => chargeSplit(100, { ...DEFAULT_FEES, cardFeeBps: 1.5 })).toThrow(RangeError);
    expect(() => chargeSplit(100, { ...DEFAULT_FEES, cardFeeFixedCents: -1 })).toThrow(RangeError);
  });
});

describe("hostEarnings", () => {
  const paid = { amountCents: 1000, platformFeeCents: 0, cardFeeCents: 40 };

  it("is the price less the fees when nothing was refunded", () => {
    expect(hostEarnings(paid, 0)).toEqual({
      grossCents: 1000,
      platformFeeCents: 0,
      cardFeeCents: 40,
      netCents: 960,
    });
  });

  it("shrinks each fee in proportion to a partial refund", () => {
    expect(hostEarnings({ ...paid, platformFeeCents: 100 }, 250)).toEqual({
      grossCents: 750,
      platformFeeCents: 75,
      cardFeeCents: 30,
      netCents: 645,
    });
    // 40 × 667 / 1000 = 26.68: rounded down.
    expect(hostEarnings(paid, 333).cardFeeCents).toBe(26);
  });

  it("is nothing after a full refund, or for a free booking", () => {
    expect(hostEarnings(paid, 1000)).toEqual({
      grossCents: 0,
      platformFeeCents: 0,
      cardFeeCents: 0,
      netCents: 0,
    });
    expect(hostEarnings({ amountCents: 0, platformFeeCents: 0, cardFeeCents: 0 }, 0).netCents).toBe(
      0,
    );
  });

  it("rejects invalid amounts", () => {
    expect(() => hostEarnings(paid, 1001)).toThrow(RangeError);
    expect(() => hostEarnings(paid, -1)).toThrow(RangeError);
    expect(() => hostEarnings({ ...paid, cardFeeCents: -1 }, 0)).toThrow(RangeError);
    expect(() => hostEarnings({ ...paid, platformFeeCents: 0.5 }, 0)).toThrow(RangeError);
    expect(() => hostEarnings({ ...paid, amountCents: -5 }, 0)).toThrow(RangeError);
  });
});

describe("cancellationRefund", () => {
  const policy = { paidCents: 1000 };

  it("refunds a driver in full until the default cutoff of 2 hours before the start", () => {
    expect(cancellationRefund(policy, "driver", minutesAfter(START, -121), START)).toEqual({
      refundCents: 1000,
      afterCutoff: false,
    });
  });

  it("refunds a driver nothing from the cutoff on", () => {
    expect(cancellationRefund(policy, "driver", minutesAfter(START, -120), START)).toEqual({
      refundCents: 0,
      afterCutoff: true,
    });
    expect(cancellationRefund(policy, "driver", minutesAfter(START, 30), START).refundCents).toBe(
      0,
    );
  });

  it("uses the host's cutoff", () => {
    const strict = { ...policy, cutoffMinutes: 24 * 60 };
    expect(cancellationRefund(strict, "driver", minutesAfter(START, -600), START).refundCents).toBe(
      0,
    );
    const none = { ...policy, cutoffMinutes: 0 };
    expect(cancellationRefund(none, "driver", minutesAfter(START, -1), START).refundCents).toBe(
      1000,
    );
  });

  it("always refunds in full when the host or the platform cancels", () => {
    const late = minutesAfter(START, -5);
    expect(cancellationRefund(policy, "host", late, START).refundCents).toBe(1000);
    expect(cancellationRefund(policy, "system", late, START).refundCents).toBe(1000);
  });

  it("rejects invalid input", () => {
    const now = minutesAfter(START, -300);
    expect(() =>
      cancellationRefund({ ...policy, cutoffMinutes: -1 }, "driver", now, START),
    ).toThrow(RangeError);
    expect(() => cancellationRefund({ paidCents: -1 }, "driver", now, START)).toThrow(RangeError);
    expect(() => cancellationRefund(policy, "driver", new Date(Number.NaN), START)).toThrow(
      RangeError,
    );
    expect(() => cancellationRefund(policy, "driver", now, new Date(Number.NaN))).toThrow(
      RangeError,
    );
  });
});

describe("requestExpiresAt", () => {
  it("gives the host 24 hours", () => {
    const requested = at("2027-01-05T09:00:00Z");
    expect(requestExpiresAt(requested, START)).toEqual(at("2027-01-06T09:00:00Z"));
  });

  it("never runs past the slot start", () => {
    expect(requestExpiresAt(minutesAfter(START, -60), START)).toEqual(START);
  });

  it("rejects invalid dates", () => {
    expect(() => requestExpiresAt(new Date(Number.NaN), START)).toThrow(RangeError);
    expect(() => requestExpiresAt(START, new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("noShowAt", () => {
  it("is 15 minutes after the slot ends", () => {
    expect(noShowAt(START)).toEqual(at("2027-01-11T22:15:00Z"));
    expect(() => noShowAt(new Date(Number.NaN))).toThrow(RangeError);
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
