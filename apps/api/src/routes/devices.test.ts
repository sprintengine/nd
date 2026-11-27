import { DEFAULT_NOTIFICATION_PREFERENCES } from "@nd/domain";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NOW, SESSION_COOKIE, signInAs, startUnitApp, USER_ID } from "../../test/unit-app.ts";
import * as data from "../data/notifications.ts";

vi.mock("../data/notifications.ts");

const DEVICE_ID = "55555555-5555-4555-8555-555555555555";
let app: FastifyInstance;

beforeEach(() => {
  ({ app } = startUnitApp());
  signInAs(app);
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

const send = (method: "POST" | "DELETE" | "GET" | "PATCH", url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: SESSION_COOKIE,
    ...(payload === undefined ? {} : { payload }),
  });

describe("POST /me/devices", () => {
  it("registers an FCM token: 201 when new, 200 when already known", async () => {
    vi.mocked(data.registerDevice)
      .mockResolvedValueOnce({ id: DEVICE_ID, created: true, createdAt: NOW })
      .mockResolvedValueOnce({ id: DEVICE_ID, created: false, createdAt: NOW });
    const body = { platform: "ios", token: "fcm-token-1" };
    const first = await send("POST", "/me/devices", body);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ id: DEVICE_ID, platform: "ios", createdAt: NOW.toISOString() });
    expect((await send("POST", "/me/devices", body)).statusCode).toBe(200);
    expect(data.registerDevice).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      { platform: "ios", token: "fcm-token-1", webPush: null },
      NOW,
    );
  });

  it("registers a web push subscription by its endpoint and keys", async () => {
    vi.mocked(data.registerDevice).mockResolvedValue({
      id: DEVICE_ID,
      created: true,
      createdAt: NOW,
    });
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: {
        p256dh:
          "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
        auth: "tBHItJI5svbpez7KI4CCXg",
      },
    };
    expect((await send("POST", "/me/devices", { platform: "web", subscription })).statusCode).toBe(
      201,
    );
    expect(vi.mocked(data.registerDevice).mock.calls[0]?.[2]).toEqual({
      platform: "web",
      token: subscription.endpoint,
      webPush: subscription.keys,
    });
  });

  it("rejects a malformed device", async () => {
    for (const body of [
      { platform: "ios" },
      { platform: "android", token: "has space" },
      { platform: "web", token: "x" },
      {
        platform: "web",
        subscription: { endpoint: "http://push.example.com/x", keys: { p256dh: "a", auth: "b" } },
      },
      {
        platform: "web",
        subscription: {
          endpoint: "https://fcm.googleapis.com/fcm/send/x",
          keys: { p256dh: "a+b", auth: "b" },
        },
      },
      // Not a browser push service: the server would otherwise POST wherever the client says.
      {
        platform: "web",
        subscription: { endpoint: "https://10.0.0.5/admin", keys: { p256dh: "a", auth: "b" } },
      },
    ]) {
      expect((await send("POST", "/me/devices", body)).statusCode).toBe(400);
    }
    expect(data.registerDevice).not.toHaveBeenCalled();
  });

  it("needs a session", async () => {
    vi.restoreAllMocks();
    const response = await app.inject({
      method: "POST",
      url: "/me/devices",
      payload: { platform: "ios", token: "t" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("DELETE /me/devices/:id", () => {
  it("forgets the caller's device, and is 404 for anyone else's", async () => {
    vi.mocked(data.deleteDevice).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await send("DELETE", `/me/devices/${DEVICE_ID}`)).statusCode).toBe(204);
    expect(data.deleteDevice).toHaveBeenCalledWith(expect.anything(), USER_ID, DEVICE_ID);
    const missing = await send("DELETE", `/me/devices/${DEVICE_ID}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "device-not-found" });
  });
});

describe("notification preferences", () => {
  it("shows every switch", async () => {
    vi.mocked(data.preferencesOf).mockResolvedValue(DEFAULT_NOTIFICATION_PREFERENCES);
    const response = await send("GET", "/me/notification-preferences");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });

  it("changes only the switches sent", async () => {
    const saved = { ...DEFAULT_NOTIFICATION_PREFERENCES, chargerAlerts: false };
    vi.mocked(data.savePreferences).mockResolvedValue(saved);
    const response = await send("PATCH", "/me/notification-preferences", { chargerAlerts: false });
    expect(response.json()).toEqual(saved);
    expect(data.savePreferences).toHaveBeenCalledWith(expect.anything(), USER_ID, {
      chargerAlerts: false,
    });
  });

  it("rejects an empty or unknown switch", async () => {
    expect((await send("PATCH", "/me/notification-preferences", {})).statusCode).toBe(400);
    expect(
      (await send("PATCH", "/me/notification-preferences", { marketing: true })).statusCode,
    ).toBe(400);
  });
});
