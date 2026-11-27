import { describe, expect, it } from "vitest";

import * as domain from "./index.ts";

describe("@nd/domain", () => {
  it("exports pricing, status vocabularies and transitions", () => {
    expect(domain.quote).toBeTypeOf("function");
    expect(
      domain.chargeSplit(1000, { platformFeeBps: 0, cardFeeBps: 150, cardFeeFixedCents: 25 })
        .hostNetCents,
    ).toBe(960);
    expect(domain.BOOKING_STATUSES).toContain("requested");
    expect(domain.canTransitionPayment).toBeTypeOf("function");
  });
});
