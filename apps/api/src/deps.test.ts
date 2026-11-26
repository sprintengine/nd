import { describe, expect, it } from "vitest";

import { randomIds, systemClock } from "./deps.ts";

describe("default dependencies", () => {
  it("tell the time and make unique ids", () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000);
    expect(randomIds.newId()).not.toBe(randomIds.newId());
  });
});
