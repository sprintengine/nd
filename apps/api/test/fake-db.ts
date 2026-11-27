import type { Db } from "@nd/db";
import * as schema from "@nd/db";
import { drizzle } from "drizzle-orm/node-postgres";

export interface RecordedQuery {
  readonly text: string;
  readonly params: readonly unknown[];
}

const TRANSACTION_CONTROL = /^\s*(begin|commit|rollback|savepoint|release)/i;

/**
 * Drizzle over a stand-in node-postgres client for unit tests: every query
 * is recorded, and each one (transaction control aside) is answered with the
 * next entry of `responses`, or no rows once they run out. Rows are arrays
 * in the order of the selected columns, as drizzle reads them.
 */
export function scriptedDb(responses: unknown[][] = []) {
  const queries: RecordedQuery[] = [];
  const queue = [...responses];
  const client = {
    query: (config: string | { text: string }, params: unknown[] = []) => {
      const text = typeof config === "string" ? config : config.text;
      if (TRANSACTION_CONTROL.test(text)) {
        return Promise.resolve({ rows: [], rowCount: 0, fields: [] });
      }
      queries.push({ text, params });
      const rows = queue.shift() ?? [];
      return Promise.resolve({ rows, rowCount: rows.length, fields: [] });
    },
  };
  // The stand-in implements only the part of pg.Client drizzle calls.
  const db = drizzle({ client: client as never, schema }) as unknown as Db;
  return { db, queries };
}
