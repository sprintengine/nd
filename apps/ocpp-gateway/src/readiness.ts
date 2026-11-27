import type { ServerResponse } from "node:http";

import pg from "pg";
import { z } from "zod";

/**
 * Settings for `/readyz`. Without `DATABASE_URL` the endpoint only reports
 * that the process is up; with it, it also checks that Postgres answers.
 */
export const readinessEnvSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
});

/** Checks the dependencies the gateway needs before it can acknowledge charger messages. */
export interface ReadinessProbe {
  /** Resolves `true` when every dependency answered. Never rejects. */
  check(): Promise<boolean>;
  close(): Promise<void>;
}

/** The part of a `pg.Pool` the probe uses. */
interface Queryable {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

/** Longest a readiness check waits for Postgres, well inside a container healthcheck timeout. */
const CHECK_TIMEOUT_MS = 2_000;

/** A probe that runs `SELECT 1` on the given pool. */
export function probeFor(pool: Queryable): ReadinessProbe {
  return {
    async check() {
      try {
        await pool.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
    close: () => pool.end(),
  };
}

/** A probe with its own single-connection pool, so checks never compete with message persistence. */
export function createDatabaseProbe(databaseUrl: string): ReadinessProbe {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: CHECK_TIMEOUT_MS,
    query_timeout: CHECK_TIMEOUT_MS,
  });
  // A dropped idle connection must not crash the process; the next check reports it.
  pool.on("error", () => undefined);
  return probeFor(pool);
}

/** Answers `GET /readyz`: 200 when ready, 503 when Postgres does not answer. */
export async function respondReadiness(
  response: ServerResponse,
  probe?: ReadinessProbe,
): Promise<void> {
  let status = 200;
  let body: Record<string, string> = { status: "ok" };
  if (probe !== undefined) {
    const ready = await probe.check();
    status = ready ? 200 : 503;
    body = ready
      ? { status: "ok", database: "ok" }
      : { status: "unavailable", database: "unreachable" };
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
