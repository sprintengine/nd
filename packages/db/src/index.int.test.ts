import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { createDb } from "./index.ts";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL must be set for integration tests");
}

const database = createDb(databaseUrl);

afterAll(async () => {
  await database.close();
});

describe("Postgres", () => {
  it("has PostGIS available", async () => {
    await database.db.execute(sql`create extension if not exists postgis`);
    const result = await database.db.execute<{ version: string }>(
      sql`select postgis_lib_version() as version`,
    );
    expect(result.rows[0]?.version).toMatch(/^3\./);
  });
});
