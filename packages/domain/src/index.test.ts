import { describe, expect, it } from "vitest";

import * as domain from "./index.ts";

describe("@nd/domain", () => {
  it("exports pricing, status vocabularies and transitions", () => {
    expect(domain.quote).toBeTypeOf("function");
    expect(domain.billableMinutes(1)).toBe(5);
    expect(domain.BOOKING_STATUSES).toContain("requested");
    expect(domain.canTransitionPayment).toBeTypeOf("function");
  });
});
