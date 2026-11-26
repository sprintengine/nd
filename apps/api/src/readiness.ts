import type { FastifyInstance } from "fastify";
import pg from "pg";
import { z } from "zod";

/**
 * Settings for `/readyz`. Without `DATABASE_URL` the endpoint only reports
 * that the process is up; with it, it also checks that Postgres answers.
 */
export const readinessEnvSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
});

/** Checks the dependencies the API needs to serve requests. */
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

/** A probe with its own single-connection pool, so checks never compete with request traffic. */
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

/** Adds `GET /readyz`: 200 when ready, 503 when Postgres does not answer. */
export function registerReadiness(app: FastifyInstance, probe?: ReadinessProbe): void {
  app.get("/readyz", async (_request, reply) => {
    if (probe === undefined) {
      return { status: "ok" };
    }
    if (await probe.check()) {
      return { status: "ok", database: "ok" };
    }
    return reply.code(503).send({ status: "unavailable", database: "unreachable" });
  });
}
