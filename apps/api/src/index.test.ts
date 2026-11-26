import { describe, expect, it } from "vitest";

import { apiEnvSchema, buildApp } from "./index.ts";

describe("buildApp", () => {
  it("answers the health check", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });
});

describe("apiEnvSchema", () => {
  it("defaults to port 3000 on all interfaces", () => {
    expect(apiEnvSchema.parse({})).toEqual({ HOST: "0.0.0.0", PORT: 3000 });
  });
});
