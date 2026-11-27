import { describe, expect, it } from "vitest";

import { scriptedDb } from "../../test/fake-db.ts";
import { fakePayments } from "../../test/fakes.ts";
import {
  cancelDeletion,
  DELETION_UNDO_DAYS,
  deletionBlockers,
  hasPendingDeletion,
  processDueDeletions,
  requestDeletion,
  revokeSessions,
} from "./deletion.ts";

// Unit tests of the query flow against a scripted database; the integration
// tests (deletion.int.test.ts) check the same functions against Postgres.

const NOW = new Date("2027-01-11T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const found = [["row-1"]];

describe("deletionBlockers", () => {
  it("reports open bookings as driver and host, and money still moving", async () => {
    const { db, queries } = scriptedDb([found, found, found]);
    const blockers = await deletionBlockers(db, "user-1");
    expect(blockers.map((blocker) => blocker.code)).toEqual([
      "open-booking",
      "host-open-booking",
      "payment-in-flight",
    ]);
    expect(queries[0]?.params).toEqual(["user-1", "completed", "cancelled", "no_show", 1]);
    expect(queries[2]?.params).toEqual(["user-1", "pending", "authorised", 1]);
  });

  it("reports a refund in flight", async () => {
    const { db, queries } = scriptedDb([[], [], [], [{ found: true }]]);
    await expect(deletionBlockers(db, "user-1")).resolves.toEqual([
      expect.objectContaining({ code: "payment-in-flight" }),
    ]);
    expect(queries[3]?.text).toContain("r.status = 'pending'");
  });

  it("is empty when nothing is open or moving", async () => {
    await expect(deletionBlockers(scriptedDb().db, "user-1")).resolves.toEqual([]);
  });
});

describe("hasPendingDeletion", () => {
  it("is true only with a pending request", async () => {
    await expect(hasPendingDeletion(scriptedDb([found]).db, "user-1")).resolves.toBe(true);
    await expect(hasPendingDeletion(scriptedDb().db, "user-1")).resolves.toBe(false);
  });
});

describe("requestDeletion", () => {
  const input = { userId: "user-1", now: NOW, undoTokenHash: "hash" };

  it("schedules the deletion and unlists the user's chargers", async () => {
    const { db, queries } = scriptedDb([
      [["user-1"]], // lock the user
      [], // no pending request
      [],
      [],
      [],
      [], // no blockers
      [["charger-1"], ["charger-2"]], // chargers unlisted
      [["deletion-1"]],
    ]);
    const result = await requestDeletion(db, input);
    expect(result).toEqual({
      status: "scheduled",
      id: "deletion-1",
      dueAt: new Date(NOW.getTime() + DELETION_UNDO_DAYS * DAY_MS),
    });
    expect(queries[0]?.text).toContain("for update");
    expect(queries.at(-1)?.params).toEqual(expect.arrayContaining(["user-1", "hash"]));
    expect(JSON.stringify(queries.at(-1)?.params)).toContain("charger-2");
  });

  it("returns a request already pending", async () => {
    const dueAt = new Date(NOW.getTime() + DAY_MS);
    const { db } = scriptedDb([[["user-1"]], [["deletion-0", dueAt]]]);
    await expect(requestDeletion(db, input)).resolves.toEqual({
      status: "scheduled",
      id: "deletion-0",
      dueAt,
    });
  });

  it("returns the blockers instead of scheduling", async () => {
    const { db, queries } = scriptedDb([[["user-1"]], [], found, [], [], []]);
    const result = await requestDeletion(db, input);
    expect(result).toEqual({
      status: "blocked",
      blockers: [expect.objectContaining({ code: "open-booking" })],
    });
    expect(queries.some((query) => query.text.startsWith("insert"))).toBe(false);
  });

  it("fails loudly if the request is not stored", async () => {
    const { db } = scriptedDb([[["user-1"]], [], [], [], [], [], [], []]);
    await expect(requestDeletion(db, input)).rejects.toThrow(/not stored/);
  });
});

describe("cancelDeletion", () => {
  const due = new Date(NOW.getTime() + DAY_MS);

  it("cancels a pending request and relists its chargers", async () => {
    const { db, queries } = scriptedDb([[["deletion-1", "user-1", due, ["charger-1"]]]]);
    await expect(cancelDeletion(db, { undoTokenHash: "hash" }, NOW)).resolves.toBe(true);
    expect(queries.map((query) => query.text.split(" ")[0])).toEqual([
      "select",
      "update",
      "update",
    ]);
    expect(queries[2]?.text).toContain('"chargers"');
  });

  it("leaves chargers alone when none were unlisted", async () => {
    const { db, queries } = scriptedDb([[["deletion-1", "user-1", due, []]]]);
    await expect(cancelDeletion(db, { id: "deletion-1" }, NOW)).resolves.toBe(true);
    expect(queries).toHaveLength(2);
  });

  it("refuses an unknown token and a request already due", async () => {
    await expect(cancelDeletion(scriptedDb().db, { id: "nope" }, NOW)).resolves.toBe(false);
    const { db } = scriptedDb([[["deletion-1", "user-1", NOW, []]]]);
    await expect(cancelDeletion(db, { id: "deletion-1" }, NOW)).resolves.toBe(false);
  });
});

describe("revokeSessions", () => {
  it("deletes every session of the user", async () => {
    const { db, queries } = scriptedDb();
    await revokeSessions(db, "user-1");
    expect(queries[0]?.text).toContain('delete from "auth_sessions"');
    expect(queries[0]?.params).toEqual(["user-1"]);
  });
});

describe("processDueDeletions", () => {
  const options = () => {
    const payments = fakePayments();
    return { payments, options: { payments: payments.payments, taxRecordRetentionYears: 6 } };
  };

  it("anonymises a due host account in one transaction, deleting the Stripe Customer", async () => {
    const { db, queries } = scriptedDb([
      [["deletion-1"]], // due
      [["user-1"]], // locked
      [],
      [],
      [],
      [], // no blockers
      [["aoife@example.com", "+353861234567", "cus_1"]],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [["host-1"]],
      [], // never paid: no reportable earnings
    ]);
    const { payments, options: run } = options();
    await expect(processDueDeletions(db, NOW, run)).resolves.toEqual({
      completed: 1,
      skipped: [],
      failed: 0,
    });
    expect(payments.callsTo("deleteCustomer")).toEqual([
      { method: "deleteCustomer", input: "cus_1" },
    ]);
    const texts = queries.map((query) => query.text);
    expect(texts.find((text) => text.startsWith('update "users"'))).toContain('"deleted_at"');
    expect(texts.some((text) => text.includes('delete from "host_tax_details"'))).toBe(true);
    expect(texts.some((text) => text.includes("ST_SnapToGrid"))).toBe(true);
    expect(texts.at(-1)).toContain('"completed_at"');
    const verifications = queries.find((query) => query.text.includes("auth_verifications"));
    expect(verifications?.params).toEqual([
      "aoife@example.com",
      "+353861234567",
      "aoife@example.com",
    ]);
  });

  it("keeps a paid host's tax details, encrypted, for the retention period", async () => {
    const { db, queries } = scriptedDb([
      [["deletion-1"]],
      [["user-1"]],
      [],
      [],
      [],
      [],
      [["aoife@example.com", null, null]],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [["host-1"]],
      [["payment-1"]], // paid: reportable earnings
    ]);
    const { payments, options: run } = options();
    await expect(processDueDeletions(db, NOW, run)).resolves.toMatchObject({ completed: 1 });
    expect(payments.calls).toEqual([]);
    const keep = queries.find((query) => query.text.startsWith('update "host_tax_details"'));
    expect(keep?.text).toContain('"retain_until"');
    expect(keep?.params).toContain(new Date("2033-01-11T12:00:00Z").toISOString());
    expect(queries.some((query) => query.text.includes('delete from "host_tax_details"'))).toBe(
      false,
    );
  });

  it("anonymises a driver without a phone or host profile", async () => {
    const { db, queries } = scriptedDb([
      [["deletion-1"]],
      [["user-1"]],
      [],
      [],
      [],
      [],
      [["aoife@example.com", null, null]],
    ]);
    await expect(processDueDeletions(db, NOW, options().options)).resolves.toMatchObject({
      completed: 1,
    });
    expect(queries.some((query) => query.text.includes("host_tax_details"))).toBe(false);
  });

  it("leaves the request for the next run when the Stripe Customer cannot be deleted", async () => {
    const { db, queries } = scriptedDb([
      [["deletion-1"]],
      [["user-1"]],
      [],
      [],
      [],
      [],
      [["aoife@example.com", null, "cus_1"]],
    ]);
    const { payments, options: run } = options();
    payments.state.deleteCustomer = "error";
    await expect(processDueDeletions(db, NOW, run)).resolves.toEqual({
      completed: 0,
      skipped: [],
      failed: 1,
    });
    expect(queries.some((query) => query.text.startsWith('update "users"'))).toBe(false);
  });

  it("skips a request that is now blocked, or taken by another run", async () => {
    const blocked = scriptedDb([
      [["deletion-1"], ["deletion-2"]],
      [["user-1"]],
      found,
      [],
      [],
      [],
      [],
    ]);
    await expect(processDueDeletions(blocked.db, NOW, options().options)).resolves.toEqual({
      completed: 0,
      skipped: [
        { userId: "user-1", blockers: [expect.objectContaining({ code: "open-booking" })] },
      ],
      failed: 0,
    });
    expect(blocked.queries.some((query) => query.text.startsWith('update "users"'))).toBe(false);
  });

  it("does nothing for a user row that is already gone", async () => {
    const { db } = scriptedDb([[["deletion-1"]], [["user-1"]], [], [], [], [], []]);
    await expect(processDueDeletions(db, NOW, options().options)).resolves.toMatchObject({
      completed: 1,
    });
  });
});
