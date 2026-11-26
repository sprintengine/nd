import { createDb } from "@nd/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testConfig } from "../../test/config.ts";
import { outbox } from "../../test/fakes.ts";
import { startUnitApp } from "../../test/unit-app.ts";
import {
  createAuth,
  MAGIC_LINK_EXPIRES_IN_S,
  SESSION_EXPIRES_IN_S,
  SESSION_UPDATE_AGE_S,
} from "./auth.ts";

interface PluginOptions {
  sendMagicLink?: (data: { email: string; url: string; token: string }) => Promise<void>;
  sendOTP?: (data: { phoneNumber: string; code: string }) => Promise<void>;
  phoneNumberValidator?: (value: string) => boolean;
  expiresIn?: number;
}

function setup(config = testConfig()) {
  const mail = outbox();
  const auth = createAuth({
    config,
    db: createDb("postgres://nobody@127.0.0.1:1/none").db,
    ids: { newId: () => "id-1" },
    email: mail.email,
    sms: mail.sms,
  });
  const plugin = (id: string) =>
    (auth.options.plugins as unknown as { id: string; options: PluginOptions }[]).find(
      (candidate) => candidate.id === id,
    )?.options ?? {};
  return { auth, mail, plugin };
}

describe("createAuth", () => {
  it("keeps sessions for 30 days, renewing daily, and magic links for 15 minutes", () => {
    const { auth, plugin } = setup();
    expect(auth.options.session).toMatchObject({
      modelName: "authSessions",
      expiresIn: SESSION_EXPIRES_IN_S,
      updateAge: SESSION_UPDATE_AGE_S,
    });
    expect(SESSION_EXPIRES_IN_S).toBe(30 * 24 * 60 * 60);
    expect(plugin("magic-link").expiresIn).toBe(MAGIC_LINK_EXPIRES_IN_S);
    expect(MAGIC_LINK_EXPIRES_IN_S).toBe(900);
    expect(auth.options.emailAndPassword).toEqual({ enabled: false });
    expect(auth.options.telemetry).toEqual({ enabled: false });
  });

  it("emails the magic link and texts the code", async () => {
    const { plugin, mail } = setup();
    await plugin("magic-link").sendMagicLink?.({
      email: "dev@example.com",
      url: "http://localhost:3000/auth/magic-link/verify?token=t",
      token: "t",
    });
    await plugin("phone-number").sendOTP?.({ phoneNumber: "+353861234567", code: "123456" });
    expect(mail.emails[0]).toMatchObject({ to: "dev@example.com" });
    expect(mail.emails[0]?.text).toContain("token=t");
    expect(mail.texts[0]).toEqual({
      to: "+353861234567",
      body: "Your verification code is 123456",
    });
  });

  it("accepts only E.164 phone numbers", () => {
    const validate = setup().plugin("phone-number").phoneNumberValidator;
    expect(validate?.("+353861234567")).toBe(true);
    expect(validate?.("0861234567")).toBe(false);
    expect(validate?.("+0123")).toBe(false);
  });

  it("uses our id generator", () => {
    const generateId = setup().auth.options.advanced.database.generateId as
      ((options: { model: string }) => string) | undefined;
    expect(generateId?.({ model: "user" })).toBe("id-1");
  });

  it("configures social providers, secure and shared cookies from settings", () => {
    const { auth } = setup(
      testConfig({
        secureCookies: true,
        cookieDomain: "example.com",
        apple: { clientId: "apple", clientSecret: "secret", appBundleId: "com.example.app" },
        google: { clientId: "google", clientSecret: "secret" },
      }),
    );
    expect(Object.keys(auth.options.socialProviders).sort()).toEqual(["apple", "google"]);
    expect(auth.options.socialProviders.apple).toMatchObject({
      appBundleIdentifier: "com.example.app",
    });
    expect(auth.options.advanced).toMatchObject({
      useSecureCookies: true,
      crossSubDomainCookies: { enabled: true, domain: "example.com" },
    });
    const noBundle = setup(
      testConfig({ apple: { clientId: "a", clientSecret: "s", appBundleId: undefined } }),
    );
    expect(noBundle.auth.options.socialProviders.apple).not.toHaveProperty("appBundleIdentifier");
  });
});

describe("/auth/* bridge", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    ({ app } = startUnitApp());
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("serves Better Auth's routes", async () => {
    const response = await app.inject({ method: "GET", url: "/auth/ok" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("turns Better Auth errors into problems that keep its code and message", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/phone-number/verify",
      headers: { origin: "http://localhost:5173" },
      payload: { phoneNumber: "+353861234567", code: "123456" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      status: 400,
      code: "PHONE_VERIFICATION_REQUIRES_SESSION",
      type: "urn:nd:problem:PHONE_VERIFICATION_REQUIRES_SESSION",
      message: expect.stringContaining("Sign in first") as string,
      instance: "/auth/phone-number/verify",
    });
  });

  it("passes the raw body, the client IP and every cookie through", async () => {
    const handler = vi.spyOn(app.auth, "handler").mockImplementation(async (request) => {
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      return new Response(`${request.method} ${await request.text()}`, { status: 200, headers });
    });
    const response = await app.inject({
      method: "POST",
      url: "/auth/callback/apple",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-nd-client-ip": "203.0.113.9",
      },
      payload: "code=abc&state=xyz",
    });
    expect(response.body).toBe("POST code=abc&state=xyz");
    expect(response.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    const forwarded = handler.mock.calls[0]?.[0];
    expect(forwarded?.url).toBe("http://localhost:3000/auth/callback/apple");
    expect(forwarded?.headers.get("x-nd-client-ip")).toBe("127.0.0.1");
  });

  it("copies repeated headers and handles empty and odd error bodies", async () => {
    const handler = vi
      .spyOn(app.auth, "handler")
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/" } }))
      .mockResolvedValueOnce(
        new Response("not json", { status: 500, headers: { "content-type": "application/json" } }),
      );
    const redirect = await app.inject({
      method: "GET",
      url: "/auth/x",
      headers: { "accept-language": ["en", "ga"] },
    });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.body).toBe("");
    expect(handler.mock.calls[0]?.[0].headers.get("accept-language")).toBe("en, ga");
    const broken = await app.inject({ method: "GET", url: "/auth/y" });
    expect(broken.json()).toMatchObject({ status: 500, code: "AUTH_ERROR" });
  });
});
