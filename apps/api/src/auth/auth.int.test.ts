import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Harness, startHarness } from "../../test/harness.ts";
import { APP_ORIGIN, cookiesFrom, magicLinkPath } from "../../test/http.ts";

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

describe("magic link", () => {
  it("signs in once; the same link fails the second time", async () => {
    const email = "aoife@example.com";
    const sent = await h.app.inject({
      method: "POST",
      url: "/auth/sign-in/magic-link",
      headers: { origin: APP_ORIGIN },
      payload: { email, callbackURL: `${APP_ORIGIN}/signed-in` },
    });
    expect(sent.statusCode).toBe(200);
    const link = magicLinkPath(h.mail.emails, email);

    const first = await h.app.inject({ method: "GET", url: link });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe(`${APP_ORIGIN}/signed-in`);
    const cookie = cookiesFrom(first);
    expect(cookie).toContain("better-auth.session_token=");
    const setCookie = String(first.headers["set-cookie"]);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Max-Age=2592000/);

    const second = await h.app.inject({ method: "GET", url: link });
    expect(second.statusCode).toBe(302);
    expect(second.headers.location).toContain("error=INVALID_TOKEN");
    expect(cookiesFrom(second)).not.toContain("session_token");

    const me = await h.app.inject({ method: "GET", url: "/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      email,
      emailVerified: true,
      phoneVerified: false,
      isHost: false,
    });
  });
});

describe("GET /me", () => {
  it("is 401 without a cookie", async () => {
    const response = await h.app.inject({ method: "GET", url: "/me" });
    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({ status: 401, code: "unauthenticated" });
  });

  it("is 401 once the session is revoked", async () => {
    const cookie = await h.user("niamh@example.com");
    const revoke = await h.app.inject({
      method: "POST",
      url: "/auth/sign-out",
      headers: { cookie, origin: APP_ORIGIN },
    });
    expect(revoke.statusCode).toBe(200);
    const me = await h.app.inject({ method: "GET", url: "/me", headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });
});

describe("phone verification", () => {
  it("marks the signed-in user's phone as verified", async () => {
    const cookie = await h.user("cian@example.com", "+353861234567");
    const me = await h.app.inject({ method: "GET", url: "/me", headers: { cookie } });
    expect(me.json()).toMatchObject({ phoneNumber: "+353861234567", phoneVerified: true });
  });

  it("refuses a wrong code", async () => {
    const cookie = await h.user("orla@example.com");
    const headers = { cookie, origin: APP_ORIGIN };
    await h.app.inject({
      method: "POST",
      url: "/auth/phone-number/send-otp",
      headers,
      payload: { phoneNumber: "+353861234568" },
    });
    const response = await h.app.inject({
      method: "POST",
      url: "/auth/phone-number/verify",
      headers,
      payload: { phoneNumber: "+353861234568", code: "000000", updatePhoneNumber: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
  });

  it("never signs anyone in with a code alone", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/auth/phone-number/verify",
      headers: { origin: APP_ORIGIN },
      payload: { phoneNumber: "+353861234567", code: "123456" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "PHONE_VERIFICATION_REQUIRES_SESSION" });
    expect(cookiesFrom(response)).not.toContain("session_token");
  });

  it("does not offer phone sign-in", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/auth/sign-in/phone-number",
      headers: { origin: APP_ORIGIN },
      payload: { phoneNumber: "+353861234567", password: "x" },
    });
    expect(response.statusCode).toBe(404);
  });
});
