import * as schema from "@nd/db";
import { drizzle } from "drizzle-orm/node-postgres";

export interface RecordedQuery {
  readonly text: string;
  readonly params: readonly unknown[];
  /** True when drizzle asked for rows as arrays (selects and returning clauses). */
  readonly arrayRows: boolean;
}

/**
 * Drizzle over a stand-in node-postgres client that records every query and
 * answers with what `rows` returns: arrays in select order when drizzle asks
 * for array rows, objects otherwise. For unit tests that must not touch a
 * database.
 */
export function fakeDb(rows: (query: RecordedQuery) => unknown[] = () => []) {
  const queries: RecordedQuery[] = [];
  const client = {
    query: (
      config: string | { text: string; values?: unknown[]; rowMode?: string },
      params: unknown[] = [],
    ) => {
      const query =
        typeof config === "string"
          ? { text: config, params, arrayRows: false }
          : {
              text: config.text,
              params: config.values ?? params,
              arrayRows: config.rowMode === "array",
            };
      queries.push(query);
      try {
        const result = rows(query);
        return Promise.resolve({ rows: result, rowCount: result.length, fields: [] });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  // The stand-in implements only the part of pg.Client drizzle calls.
  const db = drizzle({ client: client as never, schema });
  return { db, queries };
}
