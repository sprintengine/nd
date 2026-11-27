import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { SLOT_HOLDING_BOOKING_STATUSES } from "@nd/domain";
import { describe, expect, it } from "vitest";

import { MIGRATIONS_FOLDER } from "./migrate.ts";

interface Journal {
  entries: { idx: number; tag: string }[];
}

const readMigration = (file: string) => readFile(join(MIGRATIONS_FOLDER, file), "utf8");

describe("migrations", () => {
  it("has a journal entry for every SQL file, in order", async () => {
    const journal = JSON.parse(await readMigration("meta/_journal.json")) as Journal;
    const files = (await readdir(MIGRATIONS_FOLDER)).filter((file) => file.endsWith(".sql")).sort();
    expect(journal.entries.map((entry) => `${entry.tag}.sql`)).toEqual(files);
    expect(journal.entries.map((entry) => entry.idx)).toEqual(files.map((_file, index) => index));
  });

  it("limits the booking exclusion constraint to the slot-holding statuses in @nd/domain", async () => {
    const sql = await readMigration("0002_constraints_and_audit.sql");
    const match = /EXCLUDE USING gist[\s\S]*?WHERE \("status" IN \(([^)]*)\)\)/.exec(sql);
    const statuses = match?.[1]?.split(",").map((value) => value.trim().replaceAll("'", ""));
    expect(statuses).toEqual([...SLOT_HOLDING_BOOKING_STATUSES]);
  });

  it("writes the location column as an unquoted PostGIS type", async () => {
    const sql = await readMigration("0001_schema.sql");
    expect(sql).toContain('"location" geography(Point,4326) NOT NULL');
  });
});
