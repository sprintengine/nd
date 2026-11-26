import { BOOKING_STATUSES, SLOT_HOLDING_BOOKING_STATUSES } from "@nd/domain";
import { describe, expect, it } from "vitest";

import { fakeDb } from "../test/fake-client.ts";
import { ID_TAG_MAX_LENGTH } from "./schema/tables.ts";
import { buildSeedData, seed, SEED_CENTRE } from "./seed.ts";

const now = new Date("2026-11-26T21:17:00.000Z");
const data = buildSeedData(now);

const metresFromCentre = ({ lat, lng }: { lat: number; lng: number }) => {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat - SEED_CENTRE.lat);
  const dLng = toRad(lng - SEED_CENTRE.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(SEED_CENTRE.lat)) * Math.cos(toRad(lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a));
};

describe("buildSeedData", () => {
  it("has three hosts, four chargers and two drivers", () => {
    expect(data.hosts).toHaveLength(3);
    expect(data.chargers).toHaveLength(4);
    const hostUserIds = new Set(data.hosts.map((host) => host.userId));
    expect(data.users.filter((user) => !hostUserIds.has(user.id))).toHaveLength(2);
  });

  it("places every charger within 2 km of Ranelagh", () => {
    for (const charger of data.chargers) {
      expect(metresFromCentre(charger.location)).toBeLessThan(2_000);
    }
  });

  it("has a booking in every status, all in EUR", () => {
    expect(data.bookings.map((booking) => booking.status).sort()).toEqual(
      [...BOOKING_STATUSES].sort(),
    );
    for (const booking of data.bookings) expect(booking.currency).toBe("EUR");
  });

  it("uses unique idTags within the OCPP length limit", () => {
    const tags = data.bookings.map((booking) => booking.idTag);
    expect(new Set(tags).size).toBe(tags.length);
    for (const tag of tags) {
      expect(tag).toBeTypeOf("string");
      expect(tag?.length).toBeLessThanOrEqual(ID_TAG_MAX_LENGTH);
    }
  });

  it("never overlaps slot-holding bookings on one charger", () => {
    const holding: readonly string[] = SLOT_HOLDING_BOOKING_STATUSES;
    const held = data.bookings.filter((booking) => holding.includes(booking.status ?? ""));
    for (const a of held) {
      for (const b of held) {
        if (a === b || a.chargerId !== b.chargerId) continue;
        expect(a.slot.end <= b.slot.start || b.slot.end <= a.slot.start).toBe(true);
      }
    }
  });

  it("keeps the arrived and active bookings current", () => {
    for (const status of ["arrived", "active"] as const) {
      const booking = data.bookings.find((candidate) => candidate.status === status);
      expect(booking?.slot.start.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(booking?.slot.end.getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it("satisfies the money rules the schema checks", () => {
    for (const payment of data.payments) {
      expect(payment.capturedCents ?? 0).toBeLessThanOrEqual(payment.authorisedCents ?? 0);
    }
    for (const transfer of data.transfers) {
      expect(transfer.status === "held").toBe(transfer.holdReason !== undefined);
    }
  });

  it("uses only placeholder emails", () => {
    for (const user of data.users) expect(user.email).toMatch(/@example\.com$/);
  });
});

describe("seed", () => {
  it("inserts every table in one transaction", async () => {
    const { db, queries } = fakeDb();
    await expect(seed(db, now)).resolves.toEqual({ inserted: true });
    const texts = queries.map((query) => query.text);
    expect(texts[0]).toBe("begin");
    expect(texts.at(-1)).toBe("commit");
    expect(texts.filter((text) => text.startsWith("insert into"))).toHaveLength(11);
  });

  it("does nothing when the seed users already exist", async () => {
    const { db, queries } = fakeDb((query) =>
      query.text.startsWith("select") ? [["seed-user-aoife"]] : [],
    );
    await expect(seed(db, now)).resolves.toEqual({ inserted: false });
    expect(queries.some((query) => query.text.startsWith("insert into"))).toBe(false);
  });
});
