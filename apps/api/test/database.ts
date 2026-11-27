import { randomBytes } from "node:crypto";

import { createDb, type Database, runMigrations } from "@nd/db";
import pg from "pg";

function serverUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error("DATABASE_URL must be set for integration tests");
  return url;
}

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: serverUrl() });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export interface TestDatabase extends Database {
  readonly url: string;
  /** Closes the pool and drops the database. */
  dispose(): Promise<void>;
}

/** A fresh, migrated database next to `DATABASE_URL`, dropped by `dispose`. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `nd_api_test_${randomBytes(6).toString("hex")}`;
  await admin(`create database "${name}"`);
  const url = new URL(serverUrl());
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  const database = createDb(url.toString());
  return {
    ...database,
    url: url.toString(),
    dispose: async () => {
      await database.close();
      await admin(`drop database if exists "${name}" with (force)`);
    },
  };
}
