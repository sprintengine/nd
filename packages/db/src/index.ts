import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

export interface Database {
  /** Drizzle query builder bound to the connection pool. */
  readonly db: NodePgDatabase;
  /** Closes every pooled connection. */
  close(): Promise<void>;
}

/**
 * Creates a pooled connection to Postgres. Connections open lazily, on the
 * first query, so creating a database handle never blocks start-up.
 */
export function createDb(databaseUrl: string): Database {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return {
    db: drizzle({ client: pool }),
    close: () => pool.end(),
  };
}
