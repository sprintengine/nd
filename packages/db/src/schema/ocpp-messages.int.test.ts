import { randomBytes } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase, type MigratedDatabase, pgErrorCode } from "../../test/database.ts";
import { insertCharger } from "../../test/fixtures.ts";
import { ocppMessages } from "./tables.ts";

const INSUFFICIENT_PRIVILEGE = "42501";
const INVALID_PARAMETER_VALUE = "22023";

let database: MigratedDatabase;
let chargerId: string;

const message = (ts = new Date()) => ({
  chargerId,
  direction: "in" as const,
  messageType: "call" as const,
  messageId: randomBytes(8).toString("hex"),
  action: "Heartbeat",
  payload: {},
  ts,
});

const monthsAgo = (months: number) => {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - months);
  return date;
};

beforeAll(async () => {
  database = await createMigratedDatabase();
  chargerId = await insertCharger(database.db, { lat: 53.326, lng: -6.256 });
});

afterAll(async () => {
  await database.dispose();
});

describe("ocpp_messages", () => {
  it("accepts inserts", async () => {
    await expect(
      database.db.insert(ocppMessages).values(message()).returning(),
    ).resolves.toHaveLength(1);
  });

  it("rejects UPDATE, even for the table owner", async () => {
    const [row] = await database.db.insert(ocppMessages).values(message()).returning();
    if (row === undefined) throw new Error("message not inserted");
    const code = await pgErrorCode(
      database.db
        .update(ocppMessages)
        .set({ action: "Tampered" })
        .where(eq(ocppMessages.id, row.id)),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("rejects DELETE", async () => {
    const [row] = await database.db.insert(ocppMessages).values(message()).returning();
    if (row === undefined) throw new Error("message not inserted");
    expect(
      await pgErrorCode(database.db.delete(ocppMessages).where(eq(ocppMessages.id, row.id))),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("rejects TRUNCATE", async () => {
    expect(await pgErrorCode(database.db.execute(sql`truncate ocpp_messages`))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it("rejects DELETE from a non-owner role that sets the purge flag itself", async () => {
    const role = `nd_app_${randomBytes(4).toString("hex")}`;
    await database.db.execute(sql.raw(`create role ${role} nologin`));
    try {
      await database.db.execute(
        sql.raw(`grant select, insert, update, delete on ocpp_messages to ${role}`),
      );
      const code = await pgErrorCode(
        database.db.transaction(async (tx) => {
          await tx.execute(sql.raw(`set local role ${role}`));
          await tx.execute(sql`select set_config('nd.ocpp_messages_purge', 'on', true)`);
          await tx.execute(sql`delete from ocpp_messages`);
        }),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);

      // Nor may it call the purge function, which is revoked from PUBLIC.
      const purgeCode = await pgErrorCode(
        database.db.transaction(async (tx) => {
          await tx.execute(sql.raw(`set local role ${role}`));
          await tx.execute(sql`select purge_ocpp_messages()`);
        }),
      );
      expect(purgeCode).toBe(INSUFFICIENT_PRIVILEGE);
    } finally {
      await database.db.execute(sql.raw(`drop owned by ${role}`));
      await database.db.execute(sql.raw(`drop role ${role}`));
    }
  });

  it("purges only messages past the 24-month retention period", async () => {
    const old = await database.db
      .insert(ocppMessages)
      .values([message(monthsAgo(25)), message(monthsAgo(30))])
      .returning({ id: ocppMessages.id });
    const recent = await database.db
      .insert(ocppMessages)
      .values(message(monthsAgo(23)))
      .returning({ id: ocppMessages.id });

    const result = await database.db.execute<{ deleted: string }>(
      sql`select purge_ocpp_messages() as deleted`,
    );
    expect(Number(result.rows[0]?.deleted)).toBe(old.length);

    const remaining = await database.db.select({ id: ocppMessages.id }).from(ocppMessages);
    const remainingIds = remaining.map((row) => row.id);
    for (const row of old) expect(remainingIds).not.toContain(row.id);
    for (const row of recent) expect(remainingIds).toContain(row.id);
  });

  it("leaves the append-only guard on after a purge in the same transaction", async () => {
    const code = await pgErrorCode(
      database.db.transaction(async (tx) => {
        await tx.execute(sql`select purge_ocpp_messages()`);
        await tx.execute(sql`delete from ocpp_messages`);
      }),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("refuses to purge inside the retention period", async () => {
    expect(
      await pgErrorCode(database.db.execute(sql`select purge_ocpp_messages(interval '1 day')`)),
    ).toBe(INVALID_PARAMETER_VALUE);
  });
});
