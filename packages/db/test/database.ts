import { randomBytes } from "node:crypto";

import pg from "pg";

import { createDb, type Database } from "../src/client.ts";
import { runMigrations } from "../src/migrate.ts";

/** The server integration tests run against; each test file gets its own database on it. */
export function serverUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined) {
    throw new Error("DATABASE_URL must be set for integration tests");
  }
  return url;
}

export interface TestDatabase {
  /** Connection string of the new, empty database. */
  readonly url: string;
  /** Drops the database, closing any connections still open to it. */
  drop(): Promise<void>;
}

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: serverUrl() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** Creates an empty database with a random name next to `DATABASE_URL`. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `nd_test_${randomBytes(6).toString("hex")}`;
  await admin((client) => client.query(`create database "${name}"`));
  const url = new URL(serverUrl());
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      await admin((client) => client.query(`drop database if exists "${name}" with (force)`));
    },
  };
}

export interface MigratedDatabase extends Database {
  readonly url: string;
  /** Closes the pool and drops the database. */
  dispose(): Promise<void>;
}

/** A fresh database with every migration applied. */
export async function createMigratedDatabase(): Promise<MigratedDatabase> {
  const testDatabase = await createTestDatabase();
  await runMigrations(testDatabase.url);
  const database = createDb(testDatabase.url);
  return {
    ...database,
    url: testDatabase.url,
    dispose: async () => {
      await database.close();
      await testDatabase.drop();
    },
  };
}

/** The Postgres SQLSTATE an operation failed with (drizzle wraps driver errors). */
export async function pgErrorCode(operation: Promise<unknown>): Promise<string | undefined> {
  try {
    await operation;
  } catch (error: unknown) {
    let current: unknown = error;
    while (current instanceof Error) {
      if ("code" in current && typeof current.code === "string") {
        return current.code;
      }
      current = current.cause;
    }
    throw error;
  }
  return undefined;
}
