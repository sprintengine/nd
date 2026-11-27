import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";

import {
  createDatabaseProbe,
  probeFor,
  readinessEnvSchema,
  type ReadinessProbe,
  respondReadiness,
} from "./readiness.ts";

async function readyz(probe?: ReadinessProbe) {
  const server = createServer((_request, response) => {
    void respondReadiness(response, probe);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/readyz`);
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

const fixedProbe = (ready: boolean): ReadinessProbe => ({
  check: () => Promise.resolve(ready),
  close: () => Promise.resolve(),
});

describe("respondReadiness", () => {
  it("is ready without a database to check", async () => {
    expect(await readyz()).toEqual({ status: 200, body: { status: "ok" } });
  });

  it("is ready when the database answers", async () => {
    expect(await readyz(fixedProbe(true))).toEqual({
      status: 200,
      body: { status: "ok", database: "ok" },
    });
  });

  it("returns 503 when the database does not answer", async () => {
    expect(await readyz(fixedProbe(false))).toEqual({
      status: 503,
      body: { status: "unavailable", database: "unreachable" },
    });
  });
});

describe("probeFor", () => {
  it("runs SELECT 1 and closes the pool", async () => {
    const pool = { query: vi.fn(() => Promise.resolve({})), end: vi.fn(() => Promise.resolve()) };
    const probe = probeFor(pool);
    expect(await probe.check()).toBe(true);
    expect(pool.query).toHaveBeenCalledWith("SELECT 1");
    await probe.close();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("reports a failed query as not ready", async () => {
    const probe = probeFor({
      query: () => Promise.reject(new Error("connection refused")),
      end: () => Promise.resolve(),
    });
    expect(await probe.check()).toBe(false);
  });
});

describe("createDatabaseProbe", () => {
  it("is not ready when nothing listens at DATABASE_URL", async () => {
    const probe = createDatabaseProbe("postgres://nd:nd@127.0.0.1:1/nd");
    expect(await probe.check()).toBe(false);
    await probe.close();
  });
});

describe("readinessEnvSchema", () => {
  it("treats DATABASE_URL as optional", () => {
    expect(readinessEnvSchema.parse({})).toEqual({});
  });
});
