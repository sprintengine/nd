import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "../src/schema/index.ts";

export interface RecordedQuery {
  readonly text: string;
  readonly params: readonly unknown[];
}

/**
 * Drizzle over a stand-in node-postgres client that records every query and
 * answers with `rows`, for unit tests that must not touch a database.
 */
export function fakeDb(rows: (query: RecordedQuery) => unknown[] = () => []) {
  const queries: RecordedQuery[] = [];
  const client = {
    query: (config: string | { text: string }, params: unknown[] = []) => {
      const query = { text: typeof config === "string" ? config : config.text, params };
      queries.push(query);
      const result = rows(query);
      return Promise.resolve({ rows: result, rowCount: result.length, fields: [] });
    },
  };
  // The stand-in implements only the part of pg.Client drizzle calls.
  const db = drizzle({ client: client as never, schema });
  return { db, queries };
}
