import { createChargerControlClient } from "@nd/domain";
import { describe, expect, it } from "vitest";

import { silentLogger } from "../test/silent-logger.ts";
import { startGateway } from "./app.ts";

const SECRET = "app-test-internal-secret-0123456789abcdef";

describe("startGateway", () => {
  it("serves health, readiness and the internal endpoint, and closes cleanly", async () => {
    // Nothing listens here: connections are lazy, so the gateway starts and reports not ready.
    const gateway = await startGateway({
      databaseUrl: "postgres://nd:nd@127.0.0.1:1/nd",
      host: "127.0.0.1",
      port: 0,
      internal: { host: "127.0.0.1", port: 0, secret: SECRET },
      logger: silentLogger,
      timings: { offlineCheckMs: 60_000 },
    });
    try {
      expect(gateway.ocppUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/v16\/$/);
      const http = gateway.ocppUrl.replace("ws://", "http://").replace("/v16/", "");
      expect((await fetch(`${http}/healthz`)).status).toBe(200);
      expect((await fetch(`${http}/readyz`)).status).toBe(503);

      const control = createChargerControlClient({ baseUrl: gateway.internalUrl, secret: SECRET });
      await expect(control.reset({ chargeboxId: "21234567" })).resolves.toMatchObject({
        ok: false,
        reason: "offline",
      });
      expect(gateway.registry.size).toBe(0);
    } finally {
      await gateway.close();
    }
  });

  it("fails to start when a port is taken", async () => {
    const first = await startGateway({
      databaseUrl: "postgres://nd:nd@127.0.0.1:1/nd",
      host: "127.0.0.1",
      port: 0,
      internal: { host: "127.0.0.1", port: 0, secret: SECRET },
      logger: silentLogger,
    });
    const port = Number(new URL(first.internalUrl).port);
    try {
      await expect(
        startGateway({
          databaseUrl: "postgres://nd:nd@127.0.0.1:1/nd",
          host: "127.0.0.1",
          port: 0,
          internal: { host: "127.0.0.1", port, secret: SECRET },
          logger: silentLogger,
        }),
      ).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await first.close();
    }
  });
});
