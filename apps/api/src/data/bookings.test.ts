import { describe, expect, it } from "vitest";

import { scriptedDb } from "../../test/fake-db.ts";
import { findBookingDetails } from "./bookings.ts";

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

describe("findBookingDetails", () => {
  it("reads every booking in one query", async () => {
    const { db, queries } = scriptedDb();
    await expect(findBookingDetails(db, IDS)).resolves.toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toMatch(/"bookings"\."id" in \(\$1, \$2, \$3\)/);
    expect(queries[0]?.params).toEqual(IDS);
  });

  it("asks nothing for no ids", async () => {
    const { db, queries } = scriptedDb();
    await expect(findBookingDetails(db, [])).resolves.toEqual([]);
    expect(queries).toHaveLength(0);
  });
});
