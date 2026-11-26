import { describe, expect, it } from "vitest";

import { billableMinutes } from "./index.ts";

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
