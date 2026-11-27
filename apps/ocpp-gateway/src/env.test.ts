import { describe, expect, it } from "vitest";

import { runtimeEnvSchema } from "./env.ts";

describe("runtimeEnvSchema", () => {
  const secret = "x".repeat(32);

  it("defaults the internal endpoint to loopback port 9100", () => {
    expect(
      runtimeEnvSchema.parse({
        DATABASE_URL: "postgres://nd:nd@db:5432/nd",
        GATEWAY_INTERNAL_SECRET: secret,
      }),
    ).toEqual({
      DATABASE_URL: "postgres://nd:nd@db:5432/nd",
      GATEWAY_INTERNAL_HOST: "127.0.0.1",
      GATEWAY_INTERNAL_PORT: 9100,
      GATEWAY_INTERNAL_SECRET: secret,
      LOG_LEVEL: "info",
    });
  });

  it("requires a database URL and a secret of at least 32 characters", () => {
    expect(runtimeEnvSchema.safeParse({ GATEWAY_INTERNAL_SECRET: secret }).success).toBe(false);
    expect(
      runtimeEnvSchema.safeParse({
        DATABASE_URL: "postgres://db/nd",
        GATEWAY_INTERNAL_SECRET: "short",
      }).success,
    ).toBe(false);
  });
});
