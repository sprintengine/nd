import { describe, expect, it } from "vitest";

import {
  CHARGER_SECRET_LENGTH,
  eligibilityProblem,
  firmwareAtLeast,
  newChargeboxId,
  newChargerSecret,
  publishBlockers,
  randomString,
  storedModel,
} from "./rules.ts";

describe("eligibilityProblem", () => {
  it("accepts a v2.1 serial and any GLO", () => {
    expect(eligibilityProblem("21234567", "zappi")).toBeUndefined();
    expect(eligibilityProblem("11234567", "zappi_glo")).toBeUndefined();
  });

  it("explains why a v2.0 cannot connect", () => {
    expect(eligibilityProblem("11234567", "zappi")).toMatch(/v2\.0/);
  });

  it("rejects other serials", () => {
    expect(eligibilityProblem("31234567", "zappi")).toMatch(/v2\.1/);
  });
});

describe("storedModel", () => {
  it("names the model the charger table uses", () => {
    expect(storedModel("zappi")).toBe("zappi_v2_1");
    expect(storedModel("zappi_glo")).toBe("zappi_glo");
  });
});

describe("firmwareAtLeast", () => {
  it.each([
    ["5.794", true],
    ["5.800", true],
    ["5.8", false],
    ["6", true],
    ["5.794.1", true],
    ["5.793", false],
    ["4.999", false],
    ["v5.8", false],
    ["", false],
  ])("%s is %s", (version, expected) => {
    expect(firmwareAtLeast(version)).toBe(expected);
  });

  it("treats unknown firmware as too old", () => {
    expect(firmwareAtLeast(null)).toBe(false);
  });

  it("compares against another minimum", () => {
    expect(firmwareAtLeast("3.1", "3.1.0")).toBe(true);
  });
});

describe("secrets", () => {
  it("makes 20-character alphanumeric secrets that differ every time", () => {
    const secrets = new Set(Array.from({ length: 50 }, () => newChargerSecret()));
    expect(secrets.size).toBe(50);
    for (const secret of secrets) {
      expect(secret).toHaveLength(CHARGER_SECRET_LENGTH);
      expect(secret).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  it("makes readable ChargeboxIDs", () => {
    expect(newChargeboxId()).toMatch(/^ND[A-HJ-NP-Z2-9]{10}$/);
  });

  it("draws from the given alphabet", () => {
    expect(randomString(30, "ab")).toMatch(/^[ab]{30}$/);
  });
});

describe("publishBlockers", () => {
  const ready = {
    status: "online",
    firmware: "5.794",
    payoutStatus: "enabled",
    taxDetailsComplete: true,
    availabilityCount: 1,
  } as const;

  it("is empty when everything is in place", () => {
    expect(publishBlockers(ready)).toEqual([]);
  });

  it("asks a charger still onboarding to finish connecting, without judging its firmware", () => {
    expect(
      publishBlockers({ ...ready, status: "onboarding", firmware: null }).map((b) => b.code),
    ).toEqual(["charger-not-online"]);
  });

  it("lists every unmet condition", () => {
    const blockers = publishBlockers({
      status: "offline",
      firmware: "5.1",
      payoutStatus: "pending",
      taxDetailsComplete: false,
      availabilityCount: 0,
    });
    expect(blockers.map((blocker) => blocker.code)).toEqual([
      "charger-not-online",
      "firmware-too-old",
      "payouts-not-enabled",
      "tax-details-missing",
      "no-availability",
    ]);
    expect(blockers[0]?.message).toMatch(/not online/);
  });
});
