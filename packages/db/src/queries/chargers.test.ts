import { describe, expect, it } from "vitest";

import { fakeDb } from "../../test/fake-client.ts";
import { formatTimeRange } from "../schema/columns.ts";
import { bookingsInWindow, openTransactionForCharger } from "./bookings.ts";
import {
  CHARGER_SECRET_COLUMNS,
  chargerColumns,
  findChargerByChargeboxId,
  findChargerCredentials,
  findHostByUserId,
  hostColumns,
} from "./chargers.ts";

describe("default select helpers", () => {
  it("leave out charger secrets", () => {
    for (const secret of CHARGER_SECRET_COLUMNS) expect(chargerColumns).not.toHaveProperty(secret);
    expect(chargerColumns).toHaveProperty("chargeboxId");
    expect(chargerColumns).toHaveProperty("location");
  });

  it("select every host column", () => {
    expect(hostColumns).toHaveProperty("taxDetailsComplete");
  });
});

describe("charger and host lookups", () => {
  it("select no secret columns unless asked for credentials", async () => {
    const { db, queries } = fakeDb();
    await expect(findChargerByChargeboxId(db, "cb-1")).resolves.toBeUndefined();
    await expect(findHostByUserId(db, "user-1")).resolves.toBeUndefined();
    expect(queries.map((query) => query.text).join("\n")).not.toMatch(
      /ocpp_auth_hash|tin_encrypted/,
    );

    await findChargerCredentials(db, "cb-1");
    expect(queries.at(-1)?.text).toContain('"ocpp_auth_hash"');
    expect(queries.at(-1)?.params).toEqual(["cb-1", 1]);
  });
});

describe("booking lookups", () => {
  const window = {
    start: new Date("2027-01-13T22:00:00.000Z"),
    end: new Date("2027-01-14T06:00:00.000Z"),
  };

  it("bookingsInWindow filters by charger, overlap and status", async () => {
    const { db, queries } = fakeDb();
    await bookingsInWindow(db, { chargerId: "c-1", window, statuses: ["confirmed"] });
    expect(queries[0]?.text).toContain("&&");
    expect(queries[0]?.params).toEqual(["c-1", formatTimeRange(window), "confirmed"]);
  });

  it("bookingsInWindow skips the query for an empty status list", async () => {
    const { db, queries } = fakeDb();
    await expect(bookingsInWindow(db, { chargerId: "c-1", window, statuses: [] })).resolves.toEqual(
      [],
    );
    expect(queries).toEqual([]);
  });

  it("openTransactionForCharger looks only at open sessions", async () => {
    const { db, queries } = fakeDb();
    await expect(openTransactionForCharger(db, "c-1")).resolves.toBeUndefined();
    expect(queries[0]?.params).toEqual([
      "c-1",
      "starting",
      "charging",
      "suspended_ev",
      "suspended_evse",
      1,
    ]);
  });
});
