import { createDb } from "@nd/db";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { testConfig } from "../../test/config.ts";
import {
  fakeChargerEvents,
  fakePayments,
  fakeStripe,
  memoryJobs,
  outbox,
  rejectingChargerControl,
} from "../../test/fakes.ts";
import { buildApp } from "../app.ts";
import type { AppDeps } from "../deps.ts";
import { createMessageCapture } from "../senders/capture.ts";

let app: FastifyInstance | undefined;

function deps(overrides: Partial<AppDeps> = {}): AppDeps {
  const mail = outbox();
  return {
    config: testConfig(),
    database: createDb("postgres://nobody@127.0.0.1:1/none"),
    clock: { now: () => new Date("2027-01-11T12:00:00Z") },
    ids: { newId: () => "generated-id" },
    email: mail.email,
    sms: mail.sms,
    stripe: fakeStripe().stripe,
    payments: fakePayments().payments,
    jobs: memoryJobs().runner,
    chargerControl: rejectingChargerControl,
    chargerEvents: fakeChargerEvents().events,
    ...overrides,
  };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /e2e/messages", () => {
  it("does not exist without the end-to-end test hooks", async () => {
    app = buildApp(deps());
    const response = await app.inject({ method: "GET", url: "/e2e/messages" });
    expect(response.statusCode).toBe(404);
  });

  it("lists captured messages, by recipient, uncached and outside the OpenAPI document", async () => {
    const capture = createMessageCapture();
    app = buildApp(
      deps({ email: capture.email, sms: capture.sms, testHooks: { messages: capture } }),
    );
    await capture.email.send({ to: "dev@example.com", subject: "Sign in", text: "link" });
    await capture.sms.send({ to: "+353861234567", body: "code 123456" });

    const response = await app.inject({
      method: "GET",
      url: "/e2e/messages?to=%2B353861234567",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      messages: [expect.objectContaining({ channel: "sms", text: "code 123456" })],
    });
    const all = await app.inject({ method: "GET", url: "/e2e/messages" });
    expect(all.json<{ messages: unknown[] }>().messages).toHaveLength(2);
    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.body).not.toContain("/e2e/");
  });

  it("refuses to build a production app with the hooks", () => {
    const capture = createMessageCapture();
    expect(() =>
      buildApp(
        deps({ config: testConfig({ production: true }), testHooks: { messages: capture } }),
      ),
    ).toThrow(/never run in production/);
  });
});
