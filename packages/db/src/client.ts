import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import pg from "pg";

import * as schema from "./schema/index.ts";

type Schema = typeof schema;

/** Drizzle bound to the nd schema. */
export type Db = NodePgDatabase<Schema>;

/** Anything queries can run on: the pooled database or a transaction inside it. */
export type Executor = PgDatabase<NodePgQueryResultHKT, Schema>;

export interface Database {
  /** Drizzle query builder bound to the connection pool. */
  readonly db: Db;
  /** The underlying pool, for LISTEN/NOTIFY clients and health checks. */
  readonly pool: pg.Pool;
  /** Closes every pooled connection. */
  close(): Promise<void>;
}

export interface CreateDbOptions {
  /** Maximum pooled connections (node-postgres default: 10). */
  readonly max?: number;
}

/**
 * Creates a pooled connection to Postgres. Connections open lazily, on the
 * first query, so creating a database handle never blocks start-up.
 */
export function createDb(databaseUrl: string, options: CreateDbOptions = {}): Database {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ...(options.max === undefined ? {} : { max: options.max }),
  });
  return {
    db: drizzle({ client: pool, schema }),
    pool,
    close: () => pool.end(),
  };
}
