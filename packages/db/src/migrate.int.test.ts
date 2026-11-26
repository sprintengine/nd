import { readdir } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { createDb } from "./client.ts";
import { MIGRATIONS_FOLDER, runMigrations } from "./migrate.ts";

let testDatabase: TestDatabase;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
});

afterAll(async () => {
  await testDatabase.drop();
});

describe("runMigrations", () => {
  it("applies every migration to an empty database without notices", async () => {
    const notices: string[] = [];
    await runMigrations(testDatabase.url, { onNotice: (message) => notices.push(message) });
    expect(notices).toEqual([]);

    const database = createDb(testDatabase.url);
    try {
      const applied = await database.pool.query<{ count: string }>(
        "select count(*) from drizzle.__drizzle_migrations",
      );
      const files = (await readdir(MIGRATIONS_FOLDER)).filter((file) => file.endsWith(".sql"));
      expect(Number(applied.rows[0]?.count)).toBe(files.length);

      const tables = await database.pool.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual(
        expect.arrayContaining([
          "availability_rules",
          "bookings",
          "chargers",
          "device_tokens",
          "disputes",
          "hosts",
          "meter_values",
          "ocpp_messages",
          "payments",
          "reviews",
          "sessions",
          "transfers",
          "users",
        ]),
      );

      const postgis = await database.pool.query<{ version: string }>(
        "select postgis_lib_version() as version",
      );
      expect(postgis.rows[0]?.version).toMatch(/^3\./);

      const locationType = await database.pool.query<{ type: string }>(
        "select format_type(atttypid, atttypmod) as type from pg_attribute where attrelid = 'chargers'::regclass and attname = 'location'",
      );
      expect(locationType.rows[0]?.type).toBe("geography(Point,4326)");
    } finally {
      await database.close();
    }
  });

  it("is a no-op when run again", async () => {
    await expect(runMigrations(testDatabase.url)).resolves.toBeUndefined();
  });

  it("lets concurrent callers wait for each other", async () => {
    await expect(
      Promise.all([runMigrations(testDatabase.url), runMigrations(testDatabase.url)]),
    ).resolves.toHaveLength(2);
  });
});
